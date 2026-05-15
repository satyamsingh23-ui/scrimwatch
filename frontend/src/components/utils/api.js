import axios from 'axios'

/*
  In production : React is served by FastAPI on port 8000
                  so API calls go to the same origin — no port needed
  In dev        : Vite proxy forwards /api → localhost:8000
  Either way    : baseURL = '/api' works perfectly
*/
const http = axios.create({
  baseURL: '/api',
  timeout: 8000
})

export const getStatus     = ()            => http.get('/status')
export const getIdpHistory = (hours = 24)  => http.get(`/idphistory?hours=${hours}`)
export const getSlots      = (guildId)     => http.get(`/slots/${guildId}`)
export const clearSlots    = (guildId)     => http.post(`/slots/${guildId}/clear`)
export const getChannels   = (guildId)     => http.get(`/channels/${guildId}`)
export const getLogs       = (lines = 150) => http.get(`/logs?lines=${lines}`)

export default http

// ── Stats (new) ───────────────────────────────────────────────────────
export const getLeaderboard  = (guildId, days = 7)  => http.get(`/stats/${guildId}/leaderboard?days=${days}`)
export const getRecentStats  = (guildId, limit = 20) => http.get(`/stats/${guildId}/recent?limit=${limit}`)
export const getStatsSummary = (guildId)             => http.get(`/stats/${guildId}/summary`)