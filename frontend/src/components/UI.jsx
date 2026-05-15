import { useState, useCallback } from 'react'

// ── Badge ──────────────────────────────────────────────────────────────
const BADGE_STYLES = {
  cyan:   'bg-cyan-900/40 text-cyan-300 border border-cyan-700/40',
  amber:  'bg-amber-900/40 text-amber-300 border border-amber-700/40',
  green:  'bg-green-900/40 text-green-300 border border-green-700/40',
  red:    'bg-red-900/40 text-red-300 border border-red-700/40',
  purple: 'bg-purple-900/40 text-purple-300 border border-purple-700/40',
}

function Badge({ color, children }) {
  const cls = BADGE_STYLES[color] || BADGE_STYLES.cyan
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-mono ${cls}`}>
      {children}
    </span>
  )
}

// ── Card ───────────────────────────────────────────────────────────────
function Card({ children, className }) {
  return (
    <div className={`bg-[#111320] border border-[#1e2235] rounded-xl ${className || ''}`}>
      {children}
    </div>
  )
}

// ── StatCard ───────────────────────────────────────────────────────────
const ACCENT_COLOR = {
  cyan:   'text-cyan-400',
  green:  'text-green-400',
  red:    'text-red-400',
  amber:  'text-amber-400',
  purple: 'text-purple-400',
}

function StatCard({ label, value, accent, sub }) {
  const color = ACCENT_COLOR[accent] || ACCENT_COLOR.cyan
  return (
    <Card className="p-4">
      <p className="text-[10px] text-[#5c6284] uppercase tracking-widest mb-1">{label}</p>
      <p className={`text-3xl font-semibold leading-none ${color}`}>{value ?? '—'}</p>
      {sub && <p className="text-[10px] text-[#5c6284] mt-1 font-mono">{sub}</p>}
    </Card>
  )
}

// ── Loading ────────────────────────────────────────────────────────────
function Loading({ msg }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-[#5c6284]">
      <div className="w-5 h-5 border-2 border-[#1e2235] border-t-cyan-400 rounded-full animate-spin" />
      <p className="text-xs font-mono">{msg || 'Loading…'}</p>
    </div>
  )
}

// ── Empty ──────────────────────────────────────────────────────────────
function Empty({ title, sub }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-[#5c6284]">
      <p className="text-sm text-[#c8cde8]">{title}</p>
      {sub && <p className="text-xs font-mono text-center">{sub}</p>}
    </div>
  )
}

// ── Err ────────────────────────────────────────────────────────────────
function Err({ msg }) {
  return (
    <div className="py-12 text-center">
      <p className="text-sm text-red-400 font-mono">⚠ {msg}</p>
      <p className="text-xs text-[#5c6284] mt-1">Make sure the bot backend is running on port 8000.</p>
    </div>
  )
}

// ── Input ──────────────────────────────────────────────────────────────
function Input({ className, ...props }) {
  return (
    <input
      className={`bg-[#07080f] border border-[#1e2235] rounded-lg px-3 py-2 text-sm
                  text-[#c8cde8] font-mono placeholder-[#2a2f4a] outline-none
                  focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/20 ${className || ''}`}
      {...props}
    />
  )
}

// ── Btn ────────────────────────────────────────────────────────────────
function Btn({ children, onClick, disabled, variant }) {
  const base = 'px-4 py-2 rounded-lg text-sm font-medium transition-all duration-150 disabled:opacity-40 cursor-pointer border'
  const styles = {
    ghost:   'border-[#1e2235] text-[#c8cde8] hover:border-cyan-500/40 hover:text-cyan-400 bg-transparent',
    primary: 'bg-cyan-400 text-[#07080f] font-semibold border-cyan-400 hover:bg-cyan-300',
    danger:  'border-red-500/30 text-red-400 hover:bg-red-500/10 bg-transparent',
  }
  const v = variant || 'ghost'
  return (
    <button onClick={onClick} disabled={disabled} className={`${base} ${styles[v] || styles.ghost}`}>
      {children}
    </button>
  )
}

// ── Toast ──────────────────────────────────────────────────────────────
const TOAST_BORDER = {
  success: 'border-green-500/30',
  error:   'border-red-500/30',
  info:    'border-cyan-500/30',
  warning: 'border-amber-500/30',
}
const TOAST_DOT = {
  success: 'text-green-400',
  error:   'text-red-400',
  info:    'text-cyan-400',
  warning: 'text-amber-400',
}

function ToastContainer({ toasts, dismiss }) {
  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 items-end pointer-events-none">
      {toasts.map(({ id, message, type }) => (
        <div
          key={id}
          className={`pointer-events-auto flex items-center gap-2 px-4 py-3 rounded-xl
                      bg-[#111320] border ${TOAST_BORDER[type] || TOAST_BORDER.info}
                      text-sm text-[#c8cde8] max-w-xs`}
        >
          <span className={`text-xs ${TOAST_DOT[type] || TOAST_DOT.info}`}>●</span>
          <span className="flex-1">{message}</span>
          <button onClick={() => dismiss(id)} className="text-[#5c6284] hover:text-white ml-1 text-xs">✕</button>
        </div>
      ))}
    </div>
  )
}

// ── EXPORTS — all named, explicit ──────────────────────────────────────
export { Badge }
export { Card }
export { StatCard }
export { Loading }
export { Empty }
export { Err }
export { Input }
export { Btn }
export { ToastContainer }