import { Navigate, useLocation } from "react-router-dom";

const DEV_AUTH_ENABLED = import.meta.env.VITE_DEV_AUTH_BYPASS === "true";

const AuthGuard: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const location = useLocation();
  const isAuthenticated = localStorage.getItem("isAuthenticated") === "true";

  if (DEV_AUTH_ENABLED && !isAuthenticated) {
    console.warn("[AuthGuard] DEV_AUTH_BYPASS enabled — auto-authenticating as admin");
    localStorage.setItem("isAuthenticated", "true");
    localStorage.setItem("userInfo", JSON.stringify({ name: "Dev", uid: "dev", isAdmin: true }));
    return <>{children}</>;
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
};

export default AuthGuard;
