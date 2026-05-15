export default function StatCard({ icon: Icon, label, value, accent = 'cyan', sub }) {
  const accents = {
    cyan:   'text-cyan  bg-cyan/5  border-cyan/20',
    green:  'text-green bg-green/5 border-green/20',
    red:    'text-red   bg-red/5   border-red/20',
    amber:  'text-amber bg-amber/5 border-amber/20',
    purple: 'text-purple bg-purple/10 border-purple/20',
  }
  const cls = accents[accent] || accents.cyan

  return (
    <div className="stat-card animate-fade-in group">
      <div className="flex items-center justify-between">
        <span className="text-xs text-dim font-body uppercase tracking-widest">{label}</span>
        <div className={`w-7 h-7 rounded-lg border flex items-center justify-center ${cls}`}>
          <Icon size={13} />
        </div>
      </div>
      <p className={`font-display font-bold text-3xl tracking-tight ${cls.split(' ')[0]}`}>
        {value ?? '—'}
      </p>
      {sub && <p className="text-xs text-dim font-mono">{sub}</p>}
    </div>
  )
}