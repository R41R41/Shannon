import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Login from "./pages/Login";
import ShannonUI from "./pages/ShannonUI";
import RadarPage from './pages/RadarPage';
import AuthGuard from "./components/AuthGuard/AuthGuard";
import { ToastContainer } from "./components/Toast/Toast";
import { AgentProvider } from "./contexts/AgentContext";

import { AuthSessionProvider } from './features/auth/AuthSession';

interface AppProps {
  isTest?: boolean;
}

const App: React.FC<AppProps> = ({ isTest }) => {
  return (
    <BrowserRouter>
      <ToastContainer />
      <AuthSessionProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/radar" element={<AuthGuard><RadarPage /></AuthGuard>} />
        <Route
          path="/shannonUI"
          element={
            <AuthGuard>
              <AgentProvider>
                <ShannonUI isTest={isTest} />
              </AgentProvider>
            </AuthGuard>
          }
        />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
      </AuthSessionProvider>
    </BrowserRouter>
  );
};

export default App;
