// Maps AppContext's cloudStatus state machine ('local' | 'connecting' | 'ready'
// | 'unauthorized' | 'error' — see AppContext.jsx) onto what the Dashboard's
// heartbeat indicator should show. Kept out of HeartbeatIndicator.jsx itself so
// that component file can export only the component (react-refresh rule).
//
// 'error'/'unauthorized' get their own "Sync Issue" label rather than being
// folded into 'local''s "Local Storage" text: the app IS configured for the
// cloud and is actively failing (expired session, RLS denial, outage), so
// calling that "Local Storage" would read as "this is fine, just local" when
// it isn't. Color and shape still match the local-only case (red, flat) —
// only the label and tooltip differ.
export function getCloudStatusDisplay(cloudStatus, cloudError) {
  switch (cloudStatus) {
    case 'ready':
      return { label: 'Cloud Synced', tone: 'success', shape: 'pulse', animated: true, tooltip: null };
    case 'connecting':
      return { label: 'Connecting…', tone: 'warning', shape: 'flat', animated: true, tooltip: null };
    case 'error':
      return { label: 'Sync Issue', tone: 'danger', shape: 'flat', animated: false, tooltip: cloudError || 'Could not reach the server.' };
    case 'unauthorized':
      return { label: 'Sync Issue', tone: 'danger', shape: 'flat', animated: false, tooltip: cloudError || 'Your session may have expired - sign in again.' };
    case 'local':
    default:
      return { label: 'Local Storage', tone: 'danger', shape: 'flat', animated: false, tooltip: null };
  }
}
