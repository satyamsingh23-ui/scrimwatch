import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

const tooltipStyle = {
  background: '#10121e',
  border: '1px solid #29304a',
  borderRadius: 8,
  color: '#e2e6f5',
  fontSize: 12,
}

export default function TeamPerformanceCharts({ placementData, mapData }) {
  return (
    <section className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      <article className="rounded-xl border border-[#1e2235] bg-[#10121e] p-4 sm:p-5">
        <div className="mb-4">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-400">Recent form</p>
          <h2 className="mt-1 text-base font-bold text-white">Placement · last 20 matches</h2>
          <p className="mt-1 text-[11px] text-[#737b9e]">Lower placement numbers appear higher on the chart.</p>
        </div>
        {placementData.length === 0 ? (
          <div className="flex h-64 items-center justify-center text-sm text-[#737b9e]">No placement history available.</div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={placementData} margin={{ top: 10, right: 14, bottom: 0, left: -12 }}>
              <CartesianGrid stroke="#22263b" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="match" tick={{ fill: '#737b9e', fontSize: 10 }} axisLine={{ stroke: '#30354d' }} tickLine={false} />
              <YAxis reversed domain={[1, 'dataMax']} allowDecimals={false} tick={{ fill: '#737b9e', fontSize: 10 }} axisLine={false} tickLine={false} />
              <Tooltip
                contentStyle={tooltipStyle}
                labelStyle={{ color: '#737b9e' }}
                formatter={value => [`#${value}`, 'Placement']}
                labelFormatter={(label, payload) => payload?.[0]?.payload?.date || label}
              />
              <Line type="monotone" dataKey="placement" stroke="#22d3ee" strokeWidth={2.5} dot={{ r: 3, fill: '#22d3ee', strokeWidth: 0 }} activeDot={{ r: 5, fill: '#a5f3fc' }} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        )}
      </article>

      <article className="rounded-xl border border-[#1e2235] bg-[#10121e] p-4 sm:p-5">
        <div className="mb-4">
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-400">Combat output</p>
          <h2 className="mt-1 text-base font-bold text-white">Average kills by map</h2>
          <p className="mt-1 text-[11px] text-[#737b9e]">Squad kills averaged across recorded matches.</p>
        </div>
        {mapData.length === 0 ? (
          <div className="flex h-64 items-center justify-center text-sm text-[#737b9e]">No map kill data available.</div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={mapData} margin={{ top: 10, right: 12, bottom: 0, left: -12 }}>
              <CartesianGrid stroke="#22263b" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="map" tick={{ fill: '#aab1cc', fontSize: 10 }} axisLine={{ stroke: '#30354d' }} tickLine={false} />
              <YAxis allowDecimals={false} tick={{ fill: '#737b9e', fontSize: 10 }} axisLine={false} tickLine={false} />
              <Tooltip
                contentStyle={tooltipStyle}
                formatter={value => [Number(value).toFixed(1), 'Avg kills']}
              />
              <Bar dataKey="averageKills" fill="#22d3ee" radius={[5, 5, 0, 0]} maxBarSize={42} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </article>
    </section>
  )
}
