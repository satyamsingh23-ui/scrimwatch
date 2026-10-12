import { useLocation } from 'react-router-dom'
import { timeAgo } from '../utils/format.js'

const META = {
  '/':         { title: 'Overview',     sub: 'System status & key metrics'  },
  '/activity': { title: 'Live Feed',    sub: 'Real-time IDP detections'     },
  '/slots':    { title: 'Slot Manager', sub: 'Team slot registrations'      },
  '/channels': { title: 'Channels',     sub: 'IDP & registration channels'  },
  '/history':  { title: 'IDP History',  sub: 'Past Room ID + Password log'  },
  '/logs':     { title: 'System Logs',       sub: 'Live application logs'        },
  '/stats':    { title: 'Player Stats',      sub: 'Leaderboard & match history'  },
  '/teams':    { title: 'Team Performance',  sub: 'Squad stats, roles & AI analysis' },
  '/roster':   { title: 'Roster',            sub: 'Approved players grouped by team' },
  '/settings': { title: 'Settings',          sub: 'Bot configuration & health'   },
}

export default function Topbar({ status, onRefresh, onMenu, menuOpen }) {
  const { pathname } = useLocation()
  const page = META[pathname] || { title: 'ScrimWatch', sub: '' }

  return (
    <header className="app-topbar">
      <button
        type="button"
        onClick={onMenu}
        aria-label="Open navigation menu"
        aria-expanded={menuOpen}
        className="menu-button"
      >
        <span aria-hidden="true">☰</span>
      </button>
      <div className="topbar-heading">
        <p className="text-white font-semibold text-base leading-tight">{page.title}</p>
        <p className="text-[11px] text-[#5c6284] mt-0.5 topbar-subtitle">{page.sub}</p>
      </div>
      <div className="flex items-center gap-3">
        {status?.lastDetectedAt && (
          <span className="hidden sm:block text-xs text-[#5c6284] font-mono">
            Last IDP: <span className="text-amber-400">{timeAgo(status.lastDetectedAt)}</span>
          </span>
        )}
        <button
          onClick={onRefresh}
          title="Refresh"
          aria-label="Refresh dashboard status"
          className="topbar-action rounded-lg border border-[#1e2235] flex items-center justify-center
                     text-[#5c6284] hover:text-cyan-400 hover:border-cyan-400/40 transition-all"
        >
          ↻
        </button>
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#07080f]
                        border border-[#1e2235] text-xs font-mono text-[#5c6284]">
          ▲ {status?.alertCount ?? 0} sent
        </div>
      </div>
    </header>
  )
}