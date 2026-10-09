import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

const NotificationContext = createContext();
const STORAGE_KEY = 'td_notifications';

export function NotificationProvider({ children }) {
  const [notifications, setNotifications] = useState(() => {
    try { const s = localStorage.getItem(STORAGE_KEY); return s ? JSON.parse(s) : []; }
    catch { return []; }
  });
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(notifications.slice(0, 50))); }
    catch (e) { console.error(e); }
  }, [notifications]);

  const notify = useCallback((type, title, message) => {
    const id = Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
    setNotifications(prev => [{ id, type, title, message, timestamp: new Date().toISOString(), read: false }, ...prev].slice(0, 50));
    setToasts(prev => [...prev, { id, type, title, message }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  const markAsRead = useCallback((id) => {
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
  }, []);

  const markAllAsRead = useCallback(() => {
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
  }, []);

  const clearAll = useCallback(() => setNotifications([]), []);

  const removeToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const unreadCount = notifications.filter(n => !n.read).length;

  return (
    <NotificationContext.Provider value={{ notifications, toasts, unreadCount, notify, markAsRead, markAllAsRead, clearAll, removeToast }}>
      {children}
    </NotificationContext.Provider>
  );
}

export const useNotification = () => useContext(NotificationContext);
