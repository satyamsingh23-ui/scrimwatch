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
  { to: '/settings', label: 'Settings',    icon: '⚙'  },
]

export default function Sidebar({ status }) {
  const { pathname } = useLocation()
  const online = status?.running

  function isActive(to) {
    if (to === '/') return pathname === '/'
    return pathname.startsWith(to)
  }

  return (
    <aside style={{
      position: 'fixed', top: 0, left: 0, height: '100vh', width: '208px',
      background: '#0d0f1a', borderRight: '1px solid #1e2235',
      display: 'flex', flexDirection: 'column', zIndex: 40
    }}>
      {/* Logo */}
      <div style={{ padding: '16px 14px 12px', borderBottom: '1px solid #1e2235', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 28, height: 28, borderRadius: 7, background: 'rgba(0,229,255,0.08)', border: '1px solid rgba(0,229,255,0.25)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#00e5ff', fontSize: 12, fontWeight: 700 }}>
          S
        </div>
        <div>
          <p style={{ color: '#fff', fontWeight: 600, fontSize: 14, margin: 0, lineHeight: 1 }}>ScrimWatch</p>
          <p style={{ color: '#5c6284', fontSize: 10, margin: '2px 0 0', fontFamily: 'monospace' }}>v2.0 MONITOR</p>
        </div>
      </div>

      {/* Online pill */}
      <div style={{ margin: '10px 10px 0', padding: '7px 10px', borderRadius: 8, background: '#07080f', border: '1px solid #1e2235', display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: online ? '#00ff88' : '#5c6284', flexShrink: 0, display: 'inline-block' }} />
        <span style={{ fontSize: 11, fontFamily: 'monospace', color: online ? '#00ff88' : '#5c6284' }}>
          {online ? 'BOT ONLINE' : 'BOT OFFLINE'}
        </span>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, padding: '10px 8px', display: 'flex', flexDirection: 'column', gap: 2, overflowY: 'auto' }}>
        {NAV.map(({ to, label, icon }) => {
          const active = isActive(to)
          return (
            <Link
              key={to}
              to={to}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '9px 10px', borderRadius: 7, textDecoration: 'none',
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
      <div style={{ padding: '10px 14px', borderTop: '1px solid #1e2235' }}>
        <p style={{ fontSize: 10, color: '#5c6284', fontFamily: 'monospace', margin: 0 }}>
          {status?.serverCount ?? 0} server(s) monitored
        </p>
      </div>
    </aside>
  )
}