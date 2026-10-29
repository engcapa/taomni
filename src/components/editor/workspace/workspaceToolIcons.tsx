import {
  Activity, AlertTriangle, BookOpen, Braces, Bug, FlaskConical, FolderTree,
  GitBranch, GitCommitHorizontal, GitFork, Hammer, ListTodo, ListTree, Network,
  Play, Search, ShieldCheck, TerminalSquare,
} from "./icons";

// Stable elements let the stripes retain their SVG subtrees on caret/file
// updates. Colours and sizing still follow the containing button and theme.
export const WORKSPACE_TOOL_ICONS = {
  project: <FolderTree className="h-3.5 w-3.5" />,
  commit: <GitCommitHorizontal className="h-3.5 w-3.5" />,
  structure: <ListTree className="h-3.5 w-3.5" />,
  documentation: <BookOpen className="h-3.5 w-3.5" />,
  problems: <AlertTriangle className="h-3.5 w-3.5" />,
  analysis: <Activity className="h-3.5 w-3.5" />,
  search: <Search className="h-3.5 w-3.5" />,
  structural: <Braces className="h-3.5 w-3.5" />,
  references: <ListTree className="h-3.5 w-3.5" />,
  "call-hierarchy": <GitFork className="h-3.5 w-3.5" />,
  "type-hierarchy": <Network className="h-3.5 w-3.5" />,
  todos: <ListTodo className="h-3.5 w-3.5" />,
  terminal: <TerminalSquare className="h-3.5 w-3.5" />,
  run: <Play className="h-3.5 w-3.5" />,
  build: <Hammer className="h-3.5 w-3.5" />,
  tests: <FlaskConical className="h-3.5 w-3.5" />,
  coverage: <ShieldCheck className="h-3.5 w-3.5" />,
  git: <GitBranch className="h-3.5 w-3.5" />,
  debug: <Bug className="h-3.5 w-3.5" />,
};
