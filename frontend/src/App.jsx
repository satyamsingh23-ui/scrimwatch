import React, { Suspense } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { useCallback, useEffect, useState } from 'react'

import Sidebar            from './components/Sidebar.jsx'
import Topbar             from './components/Topbar.jsx'
import { ToastContainer } from './components/UI.jsx'

import OverviewPage  from './pages/OverviewPage.jsx'
import ActivityPage  from './pages/ActivityPage.jsx'
import SlotsPage     from './pages/SlotsPage.jsx'
import ChannelsPage  from './pages/ChannelsPage.jsx'
import HistoryPage   from './pages/HistoryPage.jsx'
import LogsPage      from './pages/LogsPage.jsx'
import SettingsPage  from './pages/SettingsPage.jsx'
import StatsPage            from './pages/StatsPage.jsx'
import TeamPerformancePage  from './pages/TeamPerformancePage.jsx'
import RosterPage           from './pages/RosterPage.jsx'
import ExplorerPage         from './pages/ExplorerPage.jsx'

import { usePolling } from './hooks/usePolling.js'
import { useToast }   from './hooks/useToast.js'
import { getStatus }  from './utils/api.js'

// ── Per-route error boundary ──────────────────────────────────────────
class PageBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(e) { return { error: e } }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, fontFamily: 'monospace' }}>
          <p style={{ color: '#ff3d6b', fontSize: 14 }}>
            ⚠ Page crashed: {this.state.error.message}
          </p>
          <button
            onClick={() => this.setState({ error: null })}
            style={{ marginTop: 12, padding: '6px 16px', background: 'none',
                     border: '1px solid #1e2235', borderRadius: 8,
                     color: '#c8cde8', cursor: 'pointer', fontSize: 13 }}
          >
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

function P({ children }) {
  return <PageBoundary><Suspense fallback={<div style={{color:'#5c6284',padding:24,fontFamily:'monospace'}}>Loading…</div>}>{children}</Suspense></PageBoundary>
}

function Layout() {
  const { toasts, toast, dismiss } = useToast()
  const [drawerOpen, setDrawerOpen] = useState(false)
  const fetchStatus = useCallback(() => getStatus(), [])
  const { data: status, loading, error, refresh } = usePolling(fetchStatus, 4000)

  useEffect(() => {
    if (!drawerOpen) return undefined
    const closeOnEscape = event => {
      if (event.key === 'Escape') setDrawerOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [drawerOpen])

  return (
    <div className="app-shell">
      <Sidebar
        status={status}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
      />
      {drawerOpen && (
        <button
          type="button"
          className="drawer-overlay"
          aria-label="Close navigation menu"
          onClick={() => setDrawerOpen(false)}
        />
      )}
      <div className="app-content">
        <Topbar
          status={status}
          onRefresh={refresh}
          onMenu={() => setDrawerOpen(true)}
          menuOpen={drawerOpen}
        />
        <main className="app-main">
          <Routes>
            <Route path="/"         element={<P><OverviewPage  status={status} loading={loading} error={error} /></P>} />
            <Route path="/activity" element={<P><ActivityPage /></P>} />
            <Route path="/slots"    element={<P><SlotsPage toast={toast} /></P>} />
            <Route path="/channels" element={<P><ChannelsPage /></P>} />
            <Route path="/history"  element={<P><HistoryPage /></P>} />
            <Route path="/logs"     element={<P><LogsPage /></P>} />
            <Route path="/settings" element={<P><SettingsPage status={status} /></P>} />
            <Route path="/stats"    element={<P><StatsPage /></P>} />
            <Route path="/teams"    element={<P><TeamPerformancePage /></P>} />
            <Route path="/roster"   element={<P><RosterPage /></P>} />
            <Route path="/explore"  element={<P><ExplorerPage /></P>} />
          </Routes>
        </main>
      </div>
      <ToastContainer toasts={toasts} dismiss={dismiss} />
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Layout />
    </BrowserRouter>
  )
}