import { Navigate, useLocation } from 'react-router-dom';
import { useAuthSession } from '../../features/auth/AuthSession';

const AuthGuard: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const location = useLocation();
  const { user, loading } = useAuthSession();
  if (loading) return <p role="status">認証を確認しています…</p>;
  if (!user) return <Navigate to="/login" state={{ from: location }} replace />;
  return <>{children}</>;
};
export default AuthGuard;
