import { useState, useEffect, useCallback, useRef } from 'react'

export function usePolling(fetchFn, interval = 4000) {
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)
  const timerRef = useRef(null)

  const refresh = useCallback(async () => {
    try {
      const res = await fetchFn()
      setData(res.data)
      setError(null)
    } catch (e) {
      setError(e?.message || 'Request failed')
    } finally {
      setLoading(false)
    }
  }, [fetchFn])

  useEffect(() => {
    refresh()
    timerRef.current = setInterval(refresh, interval)
    return () => clearInterval(timerRef.current)
  }, [refresh, interval])

  return { data, loading, error, refresh }
}