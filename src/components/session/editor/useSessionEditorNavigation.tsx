import { Bookmark, Cloud, Database, Folder, Mail, Monitor, Network, Palette, Shield, Terminal as TerminalIcon } from "lucide-react";
import { useModalDraggableAndResizable } from "../../../hooks/useModalDraggableAndResizable";
import { useModalShortcuts } from "../../../hooks/useModalShortcuts";
import { type SectionTab } from "./sessionPolicy";
import { useSessionEditorActions } from "./useSessionEditorActions";
import { useSessionEditorState } from "./useSessionEditorState";


export interface UseSessionEditorNavigationContext {
  form: ReturnType<typeof useSessionEditorState>;
  actions: ReturnType<typeof useSessionEditorActions>;
  onClose: () => void;
}

export function useSessionEditorNavigation(context: UseSessionEditorNavigationContext) {
  const { form, actions, onClose } = context;

  const sectionTabs: { id: SectionTab; label: string; icon: React.ReactNode; }[] = form.proto === "File"
    ? [
      { id: "bookmark", label: form.t("sessionEditor2.sectionBookmark"), icon: <Bookmark className="w-3 h-3 inline -mt-0.5 mr-1" /> },
    ]
    : form.isProxy
      ? [
        { id: "proxy", label: form.t("sessionEditor2.proxyKindLabel"), icon: <Network className="w-3 h-3 inline -mt-0.5 mr-1" /> },
        { id: "bookmark", label: form.t("sessionEditor2.sectionBookmark"), icon: <Bookmark className="w-3 h-3 inline -mt-0.5 mr-1" /> },
      ]
      : form.isDb || form.isHBase
        ? [
          { id: "database", label: form.isHBase ? "HBase settings" : form.t("sessionEditor2.sectionDatabase"), icon: <Database className="w-3 h-3 inline -mt-0.5 mr-1" /> },
          // DB engines can tunnel through a proxy / SSH jump host; HBase does not
          // (yet) route through the loopback forwarder, so no Network tab for it.
          ...(form.isDb
            ? [{ id: "network" as SectionTab, label: form.t("sessionEditor2.sectionNetwork"), icon: <Network className="w-3 h-3 inline -mt-0.5 mr-1" /> }]
            : []),
          { id: "bookmark", label: form.t("sessionEditor2.sectionBookmark"), icon: <Bookmark className="w-3 h-3 inline -mt-0.5 mr-1" /> },
        ]
        : form.isObjectStorage
          ? [
            { id: "objectstorage", label: "Object storage", icon: <Cloud className="w-3 h-3 inline -mt-0.5 mr-1" /> },
            // Object storage (HTTPS) can route through an HTTP/SOCKS5 proxy or an
            // SSH jump host, just like the DB engines.
            { id: "network", label: form.t("sessionEditor2.sectionNetwork"), icon: <Network className="w-3 h-3 inline -mt-0.5 mr-1" /> },
            { id: "bookmark", label: form.t("sessionEditor2.sectionBookmark"), icon: <Bookmark className="w-3 h-3 inline -mt-0.5 mr-1" /> },
          ]
          : form.isMail
            ? [
              { id: "mail", label: "Mail account", icon: <Mail className="w-3 h-3 inline -mt-0.5 mr-1" /> },
              { id: "network", label: form.t("sessionEditor2.sectionNetwork"), icon: <Network className="w-3 h-3 inline -mt-0.5 mr-1" /> },
              { id: "appearance", label: "Appearance", icon: <Palette className="w-3 h-3 inline -mt-0.5 mr-1" /> },
              { id: "bookmark", label: form.t("sessionEditor2.sectionBookmark"), icon: <Bookmark className="w-3 h-3 inline -mt-0.5 mr-1" /> },
            ]
            : [
              ...(form.isSSH
                ? [{ id: "advanced" as SectionTab, label: form.t("sessionEditor2.sectionAdvancedSsh"), icon: <Shield className="w-3 h-3 inline -mt-0.5 mr-1" /> }]
                : []),
              // SFTP gets a dedicated path mappings tab
              ...(form.proto === "SFTP"
                ? [{ id: "mappings" as SectionTab, label: form.t("pathMappings.sectionTitle"), icon: <Folder className="w-3 h-3 inline -mt-0.5 mr-1" /> }]
                : []),
              // RDP gets a dedicated options tab in place of the Terminal tab
              // (terminal appearance is meaningless for a graphical RDP session).
              ...(form.isRdp
                ? [{ id: "rdp" as SectionTab, label: form.t("rdp.options.title"), icon: <Monitor className="w-3 h-3 inline -mt-0.5 mr-1" /> }]
                : form.proto === "VNC"
                  ? [{ id: "vnc" as SectionTab, label: "VNC policies", icon: <Monitor className="w-3 h-3 inline -mt-0.5 mr-1" /> }]
                  : form.supportsTerminalAppearance
                    ? [{ id: "terminal" as SectionTab, label: form.t("sessionEditor2.sectionTerminal"), icon: <TerminalIcon className="w-3 h-3 inline -mt-0.5 mr-1" /> }]
                    : []),
              { id: "network", label: form.t("sessionEditor2.sectionNetwork"), icon: <Network className="w-3 h-3 inline -mt-0.5 mr-1" /> },
              { id: "bookmark", label: form.t("sessionEditor2.sectionBookmark"), icon: <Bookmark className="w-3 h-3 inline -mt-0.5 mr-1" /> },
            ];

  const fallbackSection: SectionTab = form.isRdp
    ? "rdp"
    : form.proto === "VNC"
      ? "vnc"
      : form.supportsTerminalAppearance
        ? "terminal"
        : form.isSSH
          ? "advanced"
          : "network";

  /* If we switched away from SSH and were on the advanced tab, fall back.
   * Likewise default RDP to its own options tab and bounce non-RDP protos
   * off the rdp tab, and DB protos onto the database tab. */
  const activeSection =
    form.proto === "File"
      ? "bookmark"
      : form.isProxy
        ? (form.section === "proxy" || form.section === "bookmark" ? form.section : "proxy")
        : form.isObjectStorage
          ? (form.section === "objectstorage" || form.section === "bookmark" || form.section === "network" ? form.section : "objectstorage")
          : form.isMail
            ? (form.section === "mail" || form.section === "network" || form.section === "bookmark" || form.section === "appearance" ? form.section : "mail")
            : form.isDb || form.isHBase
              ? (form.section === "database" || form.section === "bookmark" || (form.isDb && form.section === "network") ? form.section : "database")
              : form.section === "advanced" && !form.isSSH
                ? fallbackSection
                : form.section === "rdp" && !form.isRdp
                  ? fallbackSection
                  : form.section === "vnc" && form.proto !== "VNC"
                    ? fallbackSection
                    : form.section === "mappings" && form.proto !== "SFTP"
                      ? fallbackSection
                      : form.section === "terminal" && !form.supportsTerminalAppearance
                        ? fallbackSection
                        : form.section === "database"
                          ? fallbackSection
                          : form.section === "appearance"
                            ? fallbackSection
                            : form.section;

  const { containerRef, handleRef } = useModalDraggableAndResizable({ minWidth: 600, minHeight: 400 });

  const handleShortcutTest = () => {
    if (form.testing) return;
    if (form.isSSH && form.needsHost) {
      actions.handleTestConnection();
    } else if (form.isDb) {
      void actions.handleTestDbConnection();
    } else if (form.isHBase) {
      void actions.handleTestHBaseConnection();
    } else if (form.isProxy) {
      void actions.handleTestProxyConnection();
    }
  };

  useModalShortcuts({
    onCancel: onClose,
    onSave: () => {
      void actions.handleSave();
    },
    onTest: handleShortcutTest,
  });
  return { containerRef, handleRef, sectionTabs, activeSection };
}
