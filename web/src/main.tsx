import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth";
import { Layout } from "./components/Layout";
import { Spinner, ToastProvider } from "./components/ui";
import { AdminPage } from "./pages/AdminPage";
import { DocumentPage } from "./pages/DocumentPage";
import { HandoverEditor } from "./pages/HandoverEditor";
import { HandoverReview } from "./pages/HandoverReview";
import { Home } from "./pages/Home";
import { Login } from "./pages/Login";
import { ManagerDashboard } from "./pages/ManagerDashboard";
import { ProjectWorkspace } from "./pages/ProjectWorkspace";
import "@fontsource/source-serif-4/400.css";
import "@fontsource/source-serif-4/400-italic.css";
import "@fontsource/source-serif-4/700.css";
import "./styles.css";

function App() {
  const { user, ready } = useAuth();
  if (!ready) {
    return (
      <div className="login">
        <Spinner />
      </div>
    );
  }
  if (!user) {
    return (
      <Routes>
        <Route path="*" element={<Login />} />
      </Routes>
    );
  }
  // Route guards below only shape navigation; every API call is authorized server-side.
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Home />} />
        <Route path="manager" element={user.isManager ? <ManagerDashboard /> : <Navigate to="/" replace />} />
        <Route path="admin" element={user.isAdmin ? <AdminPage /> : <Navigate to="/" replace />} />
        <Route path="handovers/:id" element={<HandoverEditor />} />
        <Route path="review/:id" element={<HandoverReview />} />
        <Route path="projects/:projectId" element={<ProjectWorkspace />} />
        <Route path="projects/:projectId/documents/:docId" element={<DocumentPage />} />
        <Route path="login" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <App />
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
