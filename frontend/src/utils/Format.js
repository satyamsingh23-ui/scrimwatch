export function timeAgo(isoString) {
  if (!isoString) return '—'
  const diff = (Date.now() - new Date(isoString).getTime()) / 1000
  if (diff < 60)  return `${Math.floor(diff)}s ago`
  if (diff < 3600) return `${Math.floor(diff/60)}m ago`
  if (diff < 86400) return `${Math.floor(diff/3600)}h ago`
  return `${Math.floor(diff/86400)}d ago`
}

export function fmtTime(isoString) {
  if (!isoString) return '—'
  return new Date(isoString).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
}

export function fmtDateTime(isoString) {
  if (!isoString) return '—'
  const d = new Date(isoString)
  return d.toLocaleDateString('en-IN', { day:'2-digit', month:'short' })
    + ' ' + d.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', hour12: false })
}

export function truncate(str, n=40) {
  if (!str) return '—'
  return str.length > n ? str.slice(0, n) + '…' : str
}