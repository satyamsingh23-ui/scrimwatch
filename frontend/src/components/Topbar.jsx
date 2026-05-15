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
  '/settings': { title: 'Settings',          sub: 'Bot configuration & health'   },
}

export default function Topbar({ status, onRefresh }) {
  const { pathname } = useLocation()
  const page = META[pathname] || { title: 'ScrimWatch', sub: '' }

  return (
    <header className="h-14 flex items-center justify-between px-6 border-b border-[#1e2235]
                       bg-[#0d0f1a]/70 backdrop-blur sticky top-0 z-30 flex-shrink-0">
      <div>
        <p className="text-white font-semibold text-base leading-none">{page.title}</p>
        <p className="text-[11px] text-[#5c6284] mt-0.5">{page.sub}</p>
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
          className="w-8 h-8 rounded-lg border border-[#1e2235] flex items-center justify-center
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