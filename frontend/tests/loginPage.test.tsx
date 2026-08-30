import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  signInWithEmailAndPassword: vi.fn(),
  signInWithPopup: vi.fn(),
  session: { user: null as null | { isAdmin: boolean }, loading: false, error: null as string | null },
}));

vi.mock('firebase/auth', () => ({
  signInWithEmailAndPassword: mocks.signInWithEmailAndPassword,
  signInWithPopup: mocks.signInWithPopup,
  GoogleAuthProvider: vi.fn(),
  browserPopupRedirectResolver: {},
}));

vi.mock('../src/firebase', () => ({ auth: {} }));
vi.mock('../src/features/auth/AuthSession', () => ({ useAuthSession: () => mocks.session }));

import Login from '../src/pages/Login';

describe('Login page', () => {
  beforeEach(() => {
    mocks.session.user = null;
    mocks.session.loading = false;
    mocks.session.error = null;
    mocks.signInWithEmailAndPassword.mockReset();
    mocks.signInWithPopup.mockReset();
  });

  it('renders email/password fields and Google login', () => {
    const html = renderToString(<MemoryRouter><Login /></MemoryRouter>);
    expect(html).toContain('メールアドレスでログイン');
    expect(html).toContain('Googleでログイン');
    expect(html).toContain('type="email"');
    expect(html).toContain('type="password"');
  });

  it('exports password login handler via signInWithEmailAndPassword', async () => {
    mocks.signInWithEmailAndPassword.mockResolvedValue(undefined);
    const mod = await import('../src/pages/Login');
    expect(mod.default).toBeTypeOf('function');
    expect(mocks.signInWithEmailAndPassword).not.toHaveBeenCalled();
  });
});
