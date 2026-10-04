"""Hardware detection: find the best compute device for AI inference.

Checks, in order of preference:

  1. NVIDIA GPU + CUDA   -> ``CUDAExecutionProvider``   (pip: onnxruntime-gpu)
  2. Any GPU on Windows  -> ``DmlExecutionProvider``    (pip: onnxruntime-directml)
     DirectML runs on Intel (Iris Xe / Arc), AMD and NVIDIA GPUs.
  3. Apple Silicon / Mac -> ``CoreMLExecutionProvider`` (pip: onnxruntime)
  4. CPU                 -> ``CPUExecutionProvider``    (always available)

The physical GPUs present are detected independently of which onnxruntime
build is installed, so the app can tell the user "you have a GPU, install X to
use it" instead of silently running on the CPU. Everything here is local: it
only queries the OS and installed packages, never the network.

Set ``MEMORA_DEVICE`` to ``cpu``, ``cuda``, ``directml`` or ``coreml`` to force
a choice (``auto`` is the default).
"""
from __future__ import annotations

import os
import platform
import shutil
import subprocess
from dataclasses import asdict, dataclass, field
from functools import lru_cache
from typing import Optional

# Provider preference, best first.
_PREFERENCE = [
    ("cuda", "CUDAExecutionProvider"),
    ("directml", "DmlExecutionProvider"),
    ("coreml", "CoreMLExecutionProvider"),
]
_CPU = "CPUExecutionProvider"

# Subprocess flag so probing doesn't flash a console window on Windows.
_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

# Virtual / remote-desktop adapters that can't run compute.
_IGNORED_ADAPTERS = ("basic display", "basic render", "remote display", "virtual", "hyper-v")


@dataclass
class GPUInfo:
    name: str
    vendor: str                       # 'nvidia' | 'amd' | 'intel' | 'apple' | 'other'
    memory_mb: Optional[int] = None
    driver: Optional[str] = None


@dataclass
class DeviceInfo:
    device: str                       # 'cuda' | 'directml' | 'coreml' | 'cpu'
    providers: list[str]              # ordered onnxruntime providers to request
    gpus: list[GPUInfo] = field(default_factory=list)
    onnxruntime: Optional[str] = None  # installed version, None if missing
    available_providers: list[str] = field(default_factory=list)
    recommended_package: Optional[str] = None  # set when a GPU is present but unused
    reason: str = ""

    @property
    def is_gpu(self) -> bool:
        return self.device != "cpu"

    def to_dict(self) -> dict:
        d = asdict(self)
        d["is_gpu"] = self.is_gpu
        return d


def _vendor(name: str) -> str:
    n = name.lower()
    if any(k in n for k in ("nvidia", "geforce", "quadro", "rtx", "tesla")):
        return "nvidia"
    if "amd" in n or "radeon" in n:
        return "amd"
    if "intel" in n:
        return "intel"
    if "apple" in n:
        return "apple"
    return "other"


def _run(cmd: list[str], timeout: float = 5.0) -> Optional[str]:
    try:
        out = subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout,
            creationflags=_NO_WINDOW,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    return out.stdout if out.returncode == 0 else None


def _nvidia_gpus() -> list[GPUInfo]:
    exe = shutil.which("nvidia-smi")
    if not exe:
        return []
    out = _run([exe, "--query-gpu=name,memory.total,driver_version",
                "--format=csv,noheader,nounits"])
    gpus: list[GPUInfo] = []
    for line in (out or "").splitlines():
        parts = [p.strip() for p in line.split(",")]
        if len(parts) >= 3 and parts[0]:
            mem = int(parts[1]) if parts[1].isdigit() else None
            gpus.append(GPUInfo(parts[0], "nvidia", mem, parts[2] or None))
    return gpus


def _windows_gpus() -> list[GPUInfo]:
    script = (
        "Get-CimInstance Win32_VideoController | ForEach-Object "
        "{ $_.Name + '|' + $_.AdapterRAM + '|' + $_.DriverVersion }"
    )
    out = _run(["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
               timeout=10.0)
    gpus: list[GPUInfo] = []
    for line in (out or "").splitlines():
        parts = line.strip().split("|")
        if len(parts) < 3 or not parts[0].strip():
            continue
        name = parts[0].strip()
        if any(k in name.lower() for k in _IGNORED_ADAPTERS):
            continue
        # AdapterRAM is a uint32 and caps at 4 GB; still a useful hint.
        ram = parts[1].strip()
        mem = int(ram) // (1024 * 1024) if ram.isdigit() else None
        gpus.append(GPUInfo(name, _vendor(name), mem, parts[2].strip() or None))
    return gpus


def _linux_gpus() -> list[GPUInfo]:
    exe = shutil.which("lspci")
    if not exe:
        return []
    gpus: list[GPUInfo] = []
    for line in (_run([exe]) or "").splitlines():
        low = line.lower()
        if "vga compatible" in low or "3d controller" in low or "display controller" in low:
            name = line.split(":", 2)[-1].strip()
            gpus.append(GPUInfo(name, _vendor(name)))
    return gpus


def _mac_gpus() -> list[GPUInfo]:
    if platform.machine() == "arm64":
        return [GPUInfo("Apple Silicon GPU", "apple")]
    return []


def detect_gpus() -> list[GPUInfo]:
    """List the physical GPUs on this machine (best effort, never raises)."""
    system = platform.system()
    try:
        nvidia = _nvidia_gpus()
        if system == "Windows":
            others = _windows_gpus()
        elif system == "Darwin":
            others = _mac_gpus()
        else:
            others = _linux_gpus()
    except Exception:
        return []
    # nvidia-smi reports NVIDIA cards more accurately; drop the OS duplicates.
    if nvidia:
        others = [g for g in others if g.vendor != "nvidia"]
    return nvidia + others


def _ort_info() -> tuple[Optional[str], list[str]]:
    try:
        import onnxruntime as ort  # type: ignore
    except Exception:
        return None, []
    try:
        return ort.__version__, list(ort.get_available_providers())
    except Exception:
        return getattr(ort, "__version__", "unknown"), []


def recommended_package(gpus: list[GPUInfo]) -> Optional[str]:
    """The onnxruntime build that would unlock the GPU(s) found, if any."""
    if not gpus:
        return None
    system = platform.system()
    has_nvidia = any(g.vendor == "nvidia" for g in gpus)
    if system == "Windows":
        # DirectML covers every vendor; CUDA is faster on NVIDIA but needs the
        # CUDA + cuDNN runtime installed separately.
        return "onnxruntime-gpu" if has_nvidia else "onnxruntime-directml"
    if system == "Darwin":
        return "onnxruntime"
    if has_nvidia:
        return "onnxruntime-gpu"
    return None


@lru_cache(maxsize=1)
def detect_device() -> DeviceInfo:
    """Pick the best execution provider for this machine. Cached per process."""
    forced = os.environ.get("MEMORA_DEVICE", "auto").strip().lower()
    gpus = detect_gpus()
    ort_version, available = _ort_info()

    if forced != "cpu":
        for key, provider in _PREFERENCE:
            if forced not in ("auto", key):
                continue
            if provider in available:
                return DeviceInfo(
                    device=key,
                    providers=[provider, _CPU],
                    gpus=gpus,
                    onnxruntime=ort_version,
                    available_providers=available,
                    reason=f"{provider} available in onnxruntime {ort_version}",
                )

    if forced == "cpu":
        reason = "forced to CPU via MEMORA_DEVICE"
    elif ort_version is None:
        reason = "onnxruntime not installed"
    elif forced != "auto":
        reason = f"MEMORA_DEVICE={forced} requested but its provider is unavailable"
    else:
        reason = "installed onnxruntime has no GPU execution provider"

    return DeviceInfo(
        device="cpu",
        providers=[_CPU],
        gpus=gpus,
        onnxruntime=ort_version,
        available_providers=available,
        recommended_package=None if forced == "cpu" else recommended_package(gpus),
        reason=reason,
    )


def describe(info: DeviceInfo) -> str:
    """One-line human summary for logs."""
    gpu_names = ", ".join(g.name for g in info.gpus) or "none detected"
    line = f"device={info.device} providers={info.providers} gpus=[{gpu_names}]"
    if info.recommended_package:
        line += f" | GPU found but unused: pip install {info.recommended_package}"
    return line
