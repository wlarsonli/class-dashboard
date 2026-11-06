// Service worker registration and push-notification subscription.
import { VAPID_PUBLIC_KEY } from './config.js';

export async function registerSW() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('sw.js');
  } catch (err) {
    console.warn('Service worker not registered', err);
    return null;
  }
}

export const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

/** 'granted' | 'default' | 'denied' | 'needs-install' (iPhone, not on Home Screen) | 'unsupported' */
export function pushState() {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!supported) return isIOS() && !isStandalone() ? 'needs-install' : 'unsupported';
  return Notification.permission;
}

function keyBytes(b64) {
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function enablePush(store) {
  if (!VAPID_PUBLIC_KEY) throw new Error('Notifications get switched on during setup. The notification key is still missing.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error("Notifications are blocked. Allow them in your device's settings for this app.");
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) });
  await store.savePushSubscription(sub);
  return sub;
}
