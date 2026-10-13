import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useApp } from '../context/AppContext';
import { supabase } from '../lib/supabase';
import TeamMoveAcknowledgeModal from './TeamMoveAcknowledgeModal';

// Renders nothing of its own — mounted once in Layout.jsx (persists across
// tab switches), purely to check for an unacknowledged team-move notice on
// this person's own account and surface the blocking acknowledge modal if
// one exists. Unlike TaskCarryForwardNotifier (whose own header comment
// explains why IT needs no backend table), a team move has no trace in data
// this session already fetches — the move happened in a DIFFERENT person's
// (the super admin's) session entirely — so this is a real one-shot fetch
// against team_move_notifications (supabase_team_move_notifications.sql),
// same category as StorageUsageCard's own fetch-on-mount effect.
export default function TeamMoveNotifier() {
  const { myEmployeeId, authReady } = useAuth();
  const { isCloud } = useApp();
  const [pending, setPending] = useState(null);

  useEffect(() => {
    if (!authReady || !myEmployeeId || !isCloud) return undefined;
    let cancelled = false;
    supabase
      .from('team_move_notifications')
      .select('*')
      .is('acknowledged_at', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .then(({ data, error }) => {
        if (cancelled || error || !data?.[0]) return;
        setPending(data[0]);
      });
    return () => { cancelled = true; };
  }, [authReady, myEmployeeId, isCloud]);

  const handleAcknowledge = async () => {
    if (!pending) return;
    const { id } = pending;
    setPending(null);
    // Best-effort — if this fails (e.g. a dropped connection), the notice
    // simply reappears next session rather than vanishing silently, which is
    // the safer failure mode for something the user is meant to actually see.
    await supabase.from('team_move_notifications').update({ acknowledged_at: new Date().toISOString() }).eq('id', id);
  };

  if (!pending) return null;
  return <TeamMoveAcknowledgeModal notification={pending} onAcknowledge={handleAcknowledge} />;
}
