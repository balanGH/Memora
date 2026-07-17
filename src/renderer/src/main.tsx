import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { initApi } from './api/client'
import App from './App'
import './styles.css'

async function bootstrap(): Promise<void> {
  await initApi()
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <HashRouter>
        <App />
      </HashRouter>
    </React.StrictMode>
  )
}

bootstrap()
