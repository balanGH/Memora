"""People relationship graph: types, CRUD, duplicates, direction, persistence,
merge/delete safety, and confirm-before-save auto-connect."""
from __future__ import annotations

import sqlite3

import pytest
from fastapi.testclient import TestClient

from app import db, repository, scanner
from app.main import app


@pytest.fixture
def client():
    with TestClient(app, base_url="http://127.0.0.1:8756") as c:
        yield c


def _person(name=None) -> int:
    with db.transaction() as conn:
        return conn.execute("INSERT INTO people(name) VALUES (?)", (name,)).lastrowid


def _media_with_faces(tmp_path, jpeg, people: list[int], name="p.jpg") -> int:
    """Index a real (throwaway) photo and attach one face per person."""
    path = jpeg(tmp_path / "lib" / name)
    fid = scanner.add_folder(str(tmp_path / "lib"))
    with db.transaction() as conn:
        scanner._index_file(conn, fid, path.resolve())
        mid = conn.execute("SELECT id FROM media WHERE path = ?", (str(path.resolve()),)).fetchone()[0]
        for pid in people:
            conn.execute(
                "INSERT INTO faces(media_id, person_id, bbox_x, bbox_y, bbox_w, bbox_h) "
                "VALUES (?, ?, 0, 0, .1, .1)", (mid, pid))
    return mid


# ------------------------------------------------------------ validation ----

@pytest.mark.parametrize("kind,directed", [
    ("parent", True), ("child", True), ("spouse", False), ("sibling", False),
    ("friend", False), ("relative", False), ("colleague", False),
])
def test_every_preset_type_saves_with_fixed_direction(client, kind, directed):
    a, b = _person("A"), _person("B")
    r = client.post("/api/relations", json={"person_a": b, "person_b": a, "kind": kind,
                                            "directed": not directed})
    assert r.status_code == 200, r.text
    rel = r.json()["relation"]
    assert rel["kind"] == kind and rel["label"] == kind
    assert bool(rel["directed"]) is directed
    if directed:  # direction preserved exactly as given
        assert (rel["person_a"], rel["person_b"]) == (b, a)
    else:  # symmetric links are normalised to a < b
        assert rel["person_a"] < rel["person_b"]


def test_custom_type_requires_label_and_keeps_direction(client):
    a, b = _person("A"), _person("B")
    assert client.post("/api/relations", json={"person_a": a, "person_b": b,
                                               "kind": "custom", "label": "  "}).status_code == 400
    r = client.post("/api/relations", json={"person_a": b, "person_b": a, "kind": "custom",
                                            "label": "mentor", "directed": True})
    assert r.status_code == 200
    rel = r.json()["relation"]
    assert (rel["kind"], rel["label"], rel["directed"]) == ("custom", "mentor", 1)
    assert (rel["person_a"], rel["person_b"]) == (b, a)


def test_unknown_type_rejected(client):
    a, b = _person(), _person()
    r = client.post("/api/relations", json={"person_a": a, "person_b": b, "kind": "nemesis"})
    assert r.status_code == 400 and "Unknown relationship type" in r.text


def test_self_and_missing_people_rejected(client):
    a = _person()
    assert client.post("/api/relations", json={"person_a": a, "person_b": a,
                                               "kind": "friend"}).status_code == 400
    assert client.post("/api/relations", json={"person_a": a, "person_b": 99999,
                                               "kind": "friend"}).status_code == 404


def test_legacy_label_only_requests_still_work(client):
    """Older clients send label + directed without kind."""
    a, b = _person(), _person()
    rel = client.post("/api/relations", json={"person_a": a, "person_b": b,
                                              "label": "Sibling"}).json()["relation"]
    assert rel["kind"] == "sibling"
    c = _person()
    rel = client.post("/api/relations", json={"person_a": a, "person_b": c,
                                              "label": "cousin"}).json()["relation"]
    assert rel["kind"] == "custom" and rel["label"] == "cousin"


def test_types_endpoint_lists_all_kinds(client):
    kinds = {t["kind"] for t in client.get("/api/relations/types").json()["types"]}
    assert kinds == {"parent", "child", "spouse", "sibling", "friend", "relative",
                     "colleague", "custom"}


# ------------------------------------------------------------- duplicates ---

def test_duplicate_pair_rejected_in_either_order(client):
    a, b = _person(), _person()
    assert client.post("/api/relations", json={"person_a": a, "person_b": b,
                                               "kind": "friend"}).status_code == 200
    for x, y in ((a, b), (b, a)):
        r = client.post("/api/relations", json={"person_a": x, "person_b": y, "kind": "sibling"})
        assert r.status_code == 409
        assert r.json()["detail"]["existing"]["kind"] == "friend"
    # directed links can't sneak a reverse duplicate in either
    r = client.post("/api/relations", json={"person_a": b, "person_b": a, "kind": "parent"})
    assert r.status_code == 409
    assert len(client.get("/api/relations").json()["edges"]) == 1


def test_replace_flag_swaps_atomically(client):
    a, b = _person(), _person()
    client.post("/api/relations", json={"person_a": a, "person_b": b, "kind": "friend"})
    r = client.post("/api/relations", json={"person_a": a, "person_b": b, "kind": "spouse",
                                            "replace": True})
    assert r.status_code == 200
    edges = client.get("/api/relations").json()["edges"]
    assert [e["kind"] for e in edges] == ["spouse"]


def test_database_enforces_unique_unordered_pair():
    a, b = _person(), _person()
    conn = db.get_conn()
    conn.execute("INSERT INTO relationships(person_a, person_b, label, kind) VALUES (?, ?, 'x', 'custom')", (a, b))
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO relationships(person_a, person_b, label, kind) VALUES (?, ?, 'y', 'custom')", (b, a))
    conn.rollback()


# ---------------------------------------------------------------- update ----

def test_update_changes_type_people_and_direction(client):
    a, b, c = _person("A"), _person("B"), _person("C")
    rid = client.post("/api/relations", json={"person_a": a, "person_b": b,
                                              "kind": "friend"}).json()["relation"]["id"]
    r = client.put(f"/api/relations/{rid}", json={"person_a": c, "person_b": a, "kind": "parent"})
    assert r.status_code == 200
    rel = r.json()["relation"]
    assert rel["id"] == rid and rel["kind"] == "parent"
    assert (rel["person_a"], rel["person_b"]) == (c, a) and rel["updated_at"]


def test_failed_update_leaves_original_untouched(client):
    a, b, c = _person(), _person(), _person()
    r1 = client.post("/api/relations", json={"person_a": a, "person_b": b, "kind": "friend"}).json()
    client.post("/api/relations", json={"person_a": a, "person_b": c, "kind": "sibling"})
    rid = r1["relation"]["id"]
    # moving it onto an already-related pair conflicts ...
    assert client.put(f"/api/relations/{rid}", json={"person_a": a, "person_b": c,
                                                     "kind": "friend"}).status_code == 409
    # ... and invalid input is rejected, without losing the original
    assert client.put(f"/api/relations/{rid}", json={"person_a": a, "person_b": b,
                                                     "kind": "custom", "label": ""}).status_code == 400
    assert repository.get_relation(rid)["kind"] == "friend"
    assert client.put("/api/relations/424242", json={"person_a": a, "person_b": b,
                                                     "kind": "friend"}).status_code == 404


def test_delete(client):
    a, b = _person(), _person()
    rid = client.post("/api/relations", json={"person_a": a, "person_b": b,
                                              "kind": "friend"}).json()["relation"]["id"]
    assert client.delete(f"/api/relations/{rid}").json() == {"ok": True}
    assert client.delete(f"/api/relations/{rid}").json() == {"ok": False}
    assert client.get("/api/relations").json()["edges"] == []


# ----------------------------------------------------------- persistence ----

def test_relationships_persist_across_restart():
    a, b = _person("Ann"), _person("Bob")
    repository.add_relation(a, b, kind="spouse")
    db.close_all(checkpoint=True)  # what shutdown does
    db.init_db()                   # what the next launch does
    graph = repository.relation_graph()
    assert [(e["kind"], e["person_a"], e["person_b"]) for e in graph["edges"]] == [("spouse", a, b)]
    assert {n["name"] for n in graph["nodes"]} == {"Ann", "Bob"}


# ------------------------------------------------- merged / deleted people --

def test_merge_repoints_relationships_and_undo_restores(tmp_path, jpeg):
    a, dup, c = _person("Ann"), _person(None), _person("Cid")
    _media_with_faces(tmp_path, jpeg, [a, dup, c])
    rel = repository.add_relation(dup, c, kind="sibling")
    op = repository.merge_people(dup, a)
    edges = repository.relation_graph()["edges"]
    assert [(e["person_a"], e["person_b"], e["kind"]) for e in edges] == [(a, c, "sibling")]
    assert repository.undo_merge(op)
    restored = repository.get_relation(rel["id"])
    assert (restored["person_a"], restored["person_b"]) == (dup, c)


def test_merge_into_already_related_person_has_no_duplicate(tmp_path, jpeg):
    a, dup, c = _person("Ann"), _person(None), _person("Cid")
    _media_with_faces(tmp_path, jpeg, [a, dup, c])
    repository.add_relation(a, c, kind="friend")
    repository.add_relation(dup, c, kind="colleague")
    repository.merge_people(dup, a)
    edges = repository.relation_graph()["edges"]
    assert len(edges) == 1 and edges[0]["kind"] == "friend"


def test_related_person_survives_when_their_photos_leave_library(tmp_path, jpeg):
    """Empty trash used to delete face-less people and cascade-delete their
    relationships silently."""
    a, b = _person("Ann"), _person("Bob")
    mid = _media_with_faces(tmp_path, jpeg, [a])
    _media_with_faces(tmp_path, jpeg, [b], name="q.jpg")
    repository.add_relation(a, b, kind="sibling")
    lonely = _person(None)  # no faces, no relations: still pruned
    repository.set_flag(mid, "is_trashed", True)
    repository.empty_trash()
    ids = {r["id"] for r in db.get_conn().execute("SELECT id FROM people")}
    assert a in ids and lonely not in ids
    assert len(repository.relation_graph()["edges"]) == 1


def test_deleting_a_person_row_cascades_safely():
    a, b = _person(), _person()
    repository.add_relation(a, b, kind="friend")
    with db.transaction() as conn:
        conn.execute("DELETE FROM people WHERE id = ?", (a,))
    assert repository.relation_graph() == {"nodes": [], "edges": []}
    assert db.integrity_report()["foreign_key_violations"] == 0


# ------------------------------------------------- no automatic relations ---

def test_auto_connect_preview_saves_nothing_and_confirm_saves_only_chosen(client, tmp_path, jpeg):
    a, b, c = _person("A"), _person("B"), _person("C")
    _media_with_faces(tmp_path, jpeg, [a, b, c], name="1.jpg")
    _media_with_faces(tmp_path, jpeg, [a, b, c], name="2.jpg")
    pairs = client.get("/api/relations/auto?min_shared=2").json()["pairs"]
    assert {(p["a"], p["b"]) for p in pairs} == {(a, b), (a, c), (b, c)}
    assert client.get("/api/relations").json()["edges"] == []  # preview is read-only

    assert client.post("/api/relations/auto", json={}).status_code == 400  # must confirm
    r = client.post("/api/relations/auto", json={"pairs": [{"a": a, "b": b}]})
    assert r.json() == {"created": 1}
    edges = client.get("/api/relations").json()["edges"]
    assert [(e["person_a"], e["person_b"], e["kind"]) for e in edges] == [(a, b, "custom")]
    # an already-related pair disappears from the preview
    assert (a, b) not in {(p["a"], p["b"]) for p in
                          client.get("/api/relations/auto?min_shared=2").json()["pairs"]}


def test_listing_relationships_never_creates_any(client, tmp_path, jpeg):
    a, b = _person(), _person()
    _media_with_faces(tmp_path, jpeg, [a, b])
    for url in ("/api/relations", "/api/relations/suggestions",
                "/api/relations/family-suggestions", "/api/relations/auto?min_shared=1"):
        assert client.get(url).status_code == 200
    assert db.get_conn().execute("SELECT COUNT(*) FROM relationships").fetchone()[0] == 0


# --------------------------------------------------------------- migration --

def test_v3_migration_backfills_kind_and_dedupes(tmp_path):
    """A pre-v3 table with free-text labels and a reversed duplicate pair."""
    db.close_all(checkpoint=False)
    for suffix in ("", "-wal", "-shm"):
        p = type(db.DB_PATH)(str(db.DB_PATH) + suffix)
        p.unlink(missing_ok=True)
    legacy = sqlite3.connect(db.DB_PATH)
    legacy.row_factory = sqlite3.Row
    legacy.executescript(db.SCHEMA_V1)
    legacy.executescript("""
        INSERT INTO people(id, name) VALUES (1,'A'),(2,'B'),(3,'C');
        INSERT INTO relationships(id, person_a, person_b, label, directed) VALUES
            (1, 1, 2, 'Friend', 0), (2, 2, 1, 'sibling', 0),
            (3, 1, 3, 'parent', 1), (4, 2, 3, 'appears with', 0);
        PRAGMA user_version = 2;
    """)
    # v2 columns, so only v3 runs
    db_conn = legacy
    db._m2_integrity_and_versioning(db_conn)
    legacy.commit()
    legacy.close()

    result = db.init_db()
    assert result["applied"] == [3] and result["backup"]
    rows = {r["id"]: (r["kind"], r["label"]) for r in
            db.get_conn().execute("SELECT id, kind, label FROM relationships")}
    assert rows == {1: ("friend", "Friend"), 3: ("parent", "parent"), 4: ("custom", "appears with")}
