import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

class RootBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(e) { return { error: e } }
  render() {
    if (this.state.error) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', height: '100vh', background: '#07080f',
          color: '#c8cde8', fontFamily: 'monospace', padding: 24, gap: 12
        }}>
          <p style={{ fontSize: 16, color: '#ff3d6b' }}>⚠ App crashed</p>
          <p style={{ fontSize: 12, color: '#ffb800', maxWidth: 600, textAlign: 'center', wordBreak: 'break-all' }}>
            {this.state.error.message}
          </p>
          <p style={{ fontSize: 11, color: '#5c6284', maxWidth: 600, textAlign: 'center' }}>
            {this.state.error.stack?.split('\n')[1]}
          </p>
          <button
            onClick={() => { this.setState({ error: null }) }}
            style={{ marginTop: 8, padding: '8px 20px', background: 'none',
                     border: '1px solid #1e2235', borderRadius: 8,
                     color: '#c8cde8', cursor: 'pointer', fontSize: 13 }}
          >
            Try again
          </button>
        </div>
      )
    }
    return this.props.children
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <RootBoundary>
      <App />
    </RootBoundary>
  </React.StrictMode>
)