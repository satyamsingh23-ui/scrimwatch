// src/utils/api.js - Updated for production deployment

import axios from 'axios'

// API Base URL - automatically uses Railway URL in production
const API_BASE_URL = import.meta.env.VITE_API_URL || 
                     (import.meta.env.DEV ? '' : 'https://your-railway-app.up.railway.app')

// Create axios instance
const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 15000,
  headers: {
    'Content-Type': 'application/json',
  },
})

// API functions
export const getStatus = () => api.get('/status')
export const getStats = () => api.get('/stats')
export const getIdpHistory = (hours = 24) => api.get(`/idphistory?hours=${hours}`)
export const getSlots = (guildId) => api.get(`/slots?guild_id=${guildId}`)
export const clearSlots = (guildId) => api.post('/slots/clear', { guild_id: guildId })
export const getChannels = (guildId) => api.get(`/channels?guild_id=${guildId}`)
export const getLogs = (lines = 150) => api.get(`/logs?lines=${lines}`)

// Start/Stop monitoring
export const startMonitoring = () => api.post('/start')
export const stopMonitoring = () => api.post('/stop')

// Test alert
export const testAlert = (message) => api.post('/test-alert', { message })

export default api