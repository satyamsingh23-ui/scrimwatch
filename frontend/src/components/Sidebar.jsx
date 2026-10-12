import { useLocation, Link } from 'react-router-dom'

const NAV = [
  { to: '/',         label: 'Overview',    icon: '⊞' },
  { to: '/activity', label: 'Live Feed',   icon: '⚡' },
  { to: '/slots',    label: 'Slots',       icon: '▦'  },
  { to: '/channels', label: 'Channels',    icon: '#'  },
  { to: '/history',  label: 'IDP History', icon: '≡'  },
  { to: '/logs',     label: 'Logs',        icon: '>'  },
  { to: '/stats',    label: 'Player Stats', icon: '📊' },
  { to: '/teams',    label: 'Teams',       icon: '⚔️'  },
  { to: '/roster',   label: 'Roster',      icon: '♙'  },
  { to: '/settings', label: 'Settings',    icon: '⚙'  },
]

export default function Sidebar({ status, open, onClose }) {
  const { pathname } = useLocation()
  const online = status?.running

  function isActive(to) {
    if (to === '/') return pathname === '/'
    return pathname.startsWith(to)
  }

  return (
    <aside className={`app-sidebar${open ? ' is-open' : ''}`} aria-label="Main navigation">
      {/* Logo */}
      <div className="sidebar-brand">
        <div style={{ width: 28, height: 28, borderRadius: 7, background: 'rgba(0,229,255,0.08)', border: '1px solid rgba(0,229,255,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#00e5ff', fontSize: 12, fontWeight: 700 }}>
          S
        </div>
        <div>
          <p style={{ color: '#fff', fontWeight: 600, fontSize: 14, margin: 0, lineHeight: 1 }}>ScrimWatch</p>
          <p style={{ color: '#5c6284', fontSize: 10, margin: '2px 0 0', fontFamily: 'monospace' }}>v2.0 MONITOR</p>
        </div>
      </div>

      {/* Online pill */}
      <div className="sidebar-status">
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: online ? '#00ff88' : '#5c6284', flexShrink: 0, display: 'inline-block' }} />
        <span style={{ fontSize: 11, fontFamily: 'monospace', color: online ? '#00ff88' : '#5c6284' }}>
          {online ? 'BOT ONLINE' : 'BOT OFFLINE'}
        </span>
      </div>

      {/* Nav */}
      <nav className="sidebar-nav">
        {NAV.map(({ to, label, icon }) => {
          const active = isActive(to)
          return (
            <Link
              key={to}
              to={to}
              onClick={onClose}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px', minHeight: 44, borderRadius: 7, textDecoration: 'none',
                fontSize: 13, cursor: 'pointer', transition: 'all 0.12s',
                borderLeft: active ? '2px solid #00e5ff' : '2px solid transparent',
                color: active ? '#00e5ff' : '#5c6284',
                background: active ? 'rgba(0,229,255,0.05)' : 'transparent',
              }}
            >
              <span style={{ fontSize: 13, width: 16, textAlign: 'center', fontFamily: 'monospace' }}>{icon}</span>
              <span>{label}</span>
            </Link>
          )
        })}
      </nav>

      {/* Footer */}
      <div className="sidebar-footer">
        <p style={{ fontSize: 10, color: '#5c6284', fontFamily: 'monospace', margin: 0 }}>
          {status?.serverCount ?? 0} server(s) monitored
        </p>
      </div>
    </aside>
  )
}