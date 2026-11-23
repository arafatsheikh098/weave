import { lazy, Suspense } from "react";
import { BrowserRouter, Route, Routes } from "react-router";
import { ToastProvider } from "./components/Toaster";
import { Skeleton } from "./components/ui";
import { AuthProvider } from "./lib/auth";
import { AuthPage } from "./pages/AuthPage";
import { LandingPage } from "./pages/LandingPage";
import { InvitePage, NotFoundPage, RequireAuth } from "./pages/misc";
import { ProjectsPage } from "./pages/ProjectsPage";

// The editor (CodeMirror + pdf.js) is a separate chunk so the landing page stays light.
const EditorPage = lazy(() => import("./pages/EditorPage").then((m) => ({ default: m.EditorPage })));

export function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <BrowserRouter>
          <Suspense fallback={<Skeleton className="m-6 h-96" />}>
            <Routes>
              <Route path="/" element={<LandingPage />} />
              <Route path="/login" element={<AuthPage mode="login" />} />
              <Route path="/signup" element={<AuthPage mode="signup" />} />
              <Route path="/invite/:token" element={<InvitePage />} />
              <Route
                path="/projects"
                element={
                  <RequireAuth>
                    <ProjectsPage />
                  </RequireAuth>
                }
              />
              <Route
                path="/p/:id"
                element={
                  <RequireAuth>
                    <EditorPage />
                  </RequireAuth>
                }
              />
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </AuthProvider>
    </ToastProvider>
  );
}
