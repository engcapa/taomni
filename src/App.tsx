import { useEffect } from "react";
import { MainLayout } from "./layouts/MainLayout";
import {
  SftpDetachedWindow,
  detectDetachedSftpRoute,
} from "./components/filebrowser/SftpDetachedWindow";
import { useAppTheme } from "./lib/appTheme";

function App() {
  const { mode, resolvedTheme } = useAppTheme();

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.appTheme = resolvedTheme;
    root.dataset.appThemeMode = mode;
    root.style.colorScheme = resolvedTheme;
  }, [mode, resolvedTheme]);

  const detachedSftpId = detectDetachedSftpRoute();
  if (detachedSftpId) {
    return <SftpDetachedWindow sessionId={detachedSftpId} />;
  }

  return <MainLayout />;
}

export default App;
