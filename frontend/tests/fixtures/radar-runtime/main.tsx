import { createRoot } from 'react-dom/client';
import { StandaloneRadarApp } from '../../../src/features/radar/StandaloneRadarApp';
import type { RadarIdentityClient, RadarIdentityUser } from '../../../src/features/radar/standaloneSession';
import '../../../src/styles/global.scss';
let user: RadarIdentityUser | null = null;
const listeners = new Set<(user: RadarIdentityUser | null) => void>();
const identity: RadarIdentityClient = {
  projectId: 'radar-fixture', currentUser: () => user,
  observe: callback => { listeners.add(callback); callback(user); return () => { listeners.delete(callback); }; },
  signIn: async (email, password) => {
    if (!['alice@example.test','bob@example.test'].includes(email) || password !== 'fixture-only') throw Error();
    const uid = email.split('@')[0]; user = { uid, getIdToken: async () => `fixture-${uid}` };
    listeners.forEach(fn => fn(user));
  },
  signOut: async () => { user = null; listeners.forEach(fn => fn(null)); },
};
createRoot(document.getElementById('root')!).render(<><aside style={{padding:12,background:'#253d38',color:'white'}}>隔離テスト・架空データのみ。alice@example.test / bob@example.test、パスワード fixture-only。実Firebaseには接続しません。</aside><StandaloneRadarApp identity={identity}/></>);
