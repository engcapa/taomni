import { MAX_TASK_NAME, parseProject, projectCopy } from "./projectXml.js";
import { readProject } from "./projectImport.js";
import { recalculateSchedule, scheduleModel } from "./projectSchedule.js";
import { MINUTE, scheduleDateText } from "./scheduleTime.js";
import { ProjectDetails, ProjectNewTask } from "./ProjectDetails.jsx";
import { detailsFor, editProject, modelForProject, projectResources, taskRecords } from "./projectOperations.js";
import { ProjectDuration } from "./ProjectDuration.jsx";
import { taskBar, timelineExtent } from "./timeline.js";
import { useDocumentDraft } from "../../../crates/taomni-plugin-api/frontend/documentDraft.js";
import styles from "./projectViewer.css?inline";

const { React, i18n } = globalThis.__taomniHost;
const { useEffect, useMemo, useRef, useState } = React;
const PAGE_SIZE = 100;
const SCHEDULE = "schedule";
const dateLabel = (value) => value?.slice(0, 10) ?? "—";
const extentLabel = (value) => new Date(value).toISOString().slice(0, 10);

export default function ProjectViewer({ document: source, active, api }) {
  const { locale } = i18n.useLocale();
  const label = (zh, en) => locale === "zh-CN" ? zh : en;
  const [state, setState] = useState(null);
  const [retry, setRetry] = useState(0);
  const [systemError, setSystemError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    async function load() {
      const bytes = await readProject(api, source, signal);
      if (signal.aborted) return;
      const project = parseProject(bytes);
      try {
        setState({ source, retry, project, model: scheduleModel(project.xml) });
      } catch (calculationError) {
        setState({ source, retry, project, calculationError: calculationError.message });
      }
    }
    void load().catch((error) => {
      if (!signal.aborted) setState({ source, retry, error: error.message ?? String(error) });
    });
    return () => controller.abort();
  }, [source, api, retry]);

  const loading = state?.source !== source || state.retry !== retry;
  return <section className="taoffice-project" aria-label={source.name} aria-busy={loading} data-testid="taoffice-project">
    <style>{styles}</style>
    {loading ? <p role="status">{label("正在打开项目…", "Opening project…")}</p>
      : state.error ? <div role="alert" data-testid="taoffice-project-error">
          <p>{label("无法打开项目。", "Could not open the project.")} {state.error}</p>
          <div className="taoffice-project-toolbar">
            <button type="button" className="taomni-btn" data-testid="taoffice-project-retry" onClick={() => {
              setSystemError("");
              setRetry((value) => value + 1);
            }}>{label("重试", "Retry")}</button>
            <button type="button" className="taomni-btn" data-testid="taoffice-project-open-system"
              onClick={() => {
                setSystemError("");
                void source.openSystem().catch((error) => setSystemError(error.message ?? String(error)));
              }}>{label("用系统应用打开", "Open in system app")}</button>
          </div>
          {systemError && <p>{systemError}</p>}
        </div>
        : <ProjectSchedule source={source} project={state.project} model={state.model}
          modelError={state.calculationError} active={active} label={label} />}
  </section>;
}

function ProjectSchedule({ source, project: original, model: originalModel, modelError, active, label }) {
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(0);
  const [calculationError, setCalculationError] = useState("");
  const [selected, setSelected] = useState(null);
  const [adding, setAdding] = useState(false);
  const detailsButton = useRef(null);
  const addButton = useRef(null);
  const draft = useDocumentDraft(source, (edits) => {
    const schedule = edits.get(SCHEDULE);
    return projectCopy(schedule?.project ?? original, edits, schedule?.dates);
  });
  const schedule = draft.edits.get(SCHEDULE);
  const project = schedule?.project ?? original;
  const model = schedule?.project ? schedule.model : originalModel;
  const records = useMemo(() => taskRecords(project.xml), [project]);
  const allTasks = schedule?.dates ? project.tasks.map((task) => {
    const dates = schedule.dates.get(task.uid);
    return dates ? { ...task, start: scheduleDateText(dates.start), finish: scheduleDateText(dates.finish),
      milestone: task.milestone || dates.duration === 0, critical: dates.critical, slack: dates.slack } : task;
  }) : project.tasks;
  const scheduled = allTasks.filter((task) => (draft.edits.get(task.uid) ?? task.name)
    .toLocaleLowerCase().includes(filter.toLocaleLowerCase()));
  const visible = scheduled.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const extent = timelineExtent(allTasks);
  const focusedTask = allTasks.find((task) => task.uid === selected);
  const detail = focusedTask && { ...detailsFor(records, selected), start: focusedTask.start, finish: focusedTask.finish };
  const save = () => { void draft.save().catch(() => {}); };

  function calculate(uid, duration) {
    const durations = new Map(schedule?.durations);
    if (uid !== undefined) durations.set(uid, duration);
    try {
      const dates = recalculateSchedule(model, durations);
      projectCopy(project, draft.edits, dates);
      draft.edit(SCHEDULE, { project, model, durations, dates }, undefined);
      setCalculationError("");
      return true;
    } catch (error) {
      setCalculationError(error.message ?? String(error));
      return false;
    }
  }

  function closeDetails() {
    setSelected(null);
    setAdding(false);
    (detailsButton.current?.isConnected ? detailsButton : addButton).current?.focus();
  }

  function applyTaskChange(action) {
    try {
      const materialized = schedule?.dates ? parseProject(projectCopy(project, new Map(), schedule.dates)) : project;
      const change = editProject(materialized, model, selected, action);
      if (!change) return true;
      let nextModel;
      if (model || change.recalculate) nextModel = modelForProject(change.project);
      const durations = new Map();
      const dates = change.recalculate && nextModel ? recalculateSchedule(nextModel, durations) : undefined;
      projectCopy(change.project, draft.edits, dates);
      draft.edit(SCHEDULE, { project: change.project, model: nextModel, durations, dates }, undefined);
      setCalculationError("");
      setSelected(change.selected);
      if (action.kind === "addTask") {
        setAdding(false);
        setFilter("");
        setPage(Math.max(0, Math.ceil(change.project.tasks.length / PAGE_SIZE) - 1));
      } else if (!change.selected) {
        addButton.current?.focus();
        setPage(0);
      }
      return true;
    } catch (error) {
      setCalculationError(error.message ?? String(error));
      return false;
    }
  }

  return <div className="taoffice-project-schedule" onKeyDown={(event) => {
    if (!active || event.nativeEvent.isComposing || event.altKey || event.shiftKey
      || !(source.platform === "macos" ? event.metaKey : event.ctrlKey)
      || event.key.toLowerCase() !== "s" || !draft.dirty) return;
    event.stopPropagation();
    event.preventDefault();
    save();
  }}>
    <div className="taoffice-project-toolbar">
      <h2>{project.title || source.name}</h2>
      <input type="search" className="taomni-input" data-testid="taoffice-project-filter"
        aria-label={label("筛选任务", "Filter tasks")} placeholder={label("筛选任务", "Filter tasks")} value={filter}
        onChange={(event) => { setFilter(event.target.value); setPage(0); }} />
      {source.saveCopy && <button type="button" className="taomni-btn" data-testid="taoffice-project-add-task"
        ref={addButton} aria-expanded={adding} disabled={draft.saving} onClick={() => {
          if (adding) { closeDetails(); return; }
          detailsButton.current = null;
          setSelected(null);
          setAdding(true);
        }}>{label("添加任务", "Add task")}</button>}
      {source.saveCopy && model && <button type="button" className="taomni-btn" data-testid="taoffice-project-recalculate"
        disabled={draft.saving} onClick={() => calculate()}>{label("重算排程", "Recalculate schedule")}</button>}
      {source.saveCopy && <button type="button" className="taomni-btn" data-variant="primary"
        data-testid="taoffice-project-save" disabled={!draft.dirty || draft.saving}
        aria-busy={draft.saving} onClick={save}>{draft.saving ? label("正在保存…", "Saving…")
          : source.extension === "mpp" ? label("保存 XML 副本", "Save XML copy") : label("保存副本", "Save a copy")}</button>}
    </div>
    {draft.output && <p role="status" data-testid="taoffice-project-output">{draft.output}</p>}
    {draft.error && <p role="alert">{draft.error}</p>}
    {calculationError && <p role="alert" data-testid="taoffice-project-schedule-error">{calculationError}</p>}
    {source.saveCopy && modelError && !model && <p role="status" data-testid="taoffice-project-schedule-error">
      {label("排程无法重算。", "Schedule recalculation is unavailable.")} {modelError}
    </p>}
    {adding && <ProjectNewTask change={applyTaskChange} close={closeDetails} saving={draft.saving} label={label} />}
    {detail && <ProjectDetails key={selected} task={{ ...focusedTask, name: draft.edits.get(selected) ?? focusedTask.name }}
      details={detail} tasks={allTasks} resources={projectResources(records)} change={applyTaskChange}
      close={closeDetails} canSchedule={!!model?.byId.has(selected)} saving={draft.saving} label={label} />}
    {visible.length ? <div className="taoffice-project-scroll">
      <table className="taoffice-project-table" data-testid="taoffice-project-schedule"
        aria-label={label("项目任务和时间轴", "Project tasks and timeline")}>
        <thead><tr>
          <th scope="col">{label("任务", "Task")}</th>
          <th scope="col">{label("开始", "Start")}</th>
          <th scope="col">{label("完成", "Finish")}</th>
          <th scope="col">{label("工期（小时）", "Duration (hours)")}</th>
          <th scope="col">{label("进度", "Progress")}</th>
          <th scope="col">{label("前置任务", "Predecessors")}</th>
          <th scope="col">
            {extent ? [extentLabel(extent.first), extentLabel(extent.last)].join(" – ") : label("时间轴", "Timeline")}
          </th>
        </tr></thead>
        <tbody>{visible.map((task) => <ProjectRow key={task.uid} task={task} extent={extent} draft={draft}
          duration={schedule?.durations.get(task.uid) ?? model?.byId.get(task.uid)?.duration}
          editDuration={source.saveCopy && model?.byId.has(task.uid) && !model.byId.get(task.uid).fixed && !task.summary
            ? (value) => calculate(task.uid, value) : undefined}
          editable={!!source.saveCopy && !!task.range} label={label}
          details={source.saveCopy ? (button) => {
            detailsButton.current = button;
            setSelected(task.uid);
            setAdding(false);
          } : null} />)}</tbody>
      </table>
    </div> : <p role="status">{filter ? label("没有匹配任务", "No matching tasks") : label("没有任务", "No tasks")}</p>}
    {scheduled.length > PAGE_SIZE && <div className="taoffice-project-toolbar">
      <button type="button" className="taomni-btn" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>{label("上一页", "Previous page")}</button>
      <span>{page + 1} / {Math.ceil(scheduled.length / PAGE_SIZE)}</span>
      <button type="button" className="taomni-btn" disabled={(page + 1) * PAGE_SIZE >= scheduled.length}
        onClick={() => setPage((value) => value + 1)}>{label("下一页", "Next page")}</button>
    </div>}
  </div>;
}

function ProjectRow({ task, extent, draft, duration, editDuration, editable, label, details }) {
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState("");
  const editButton = useRef(null);
  const focusEditButton = useRef(false);
  const nameField = useRef(null);
  const name = draft.edits.get(task.uid) ?? task.name;
  const bar = taskBar(task, extent);
  useEffect(() => {
    if (editing) nameField.current?.focus();
    else if (focusEditButton.current) {
      focusEditButton.current = false;
      editButton.current?.focus();
    }
  }, [editing]);

  return <tr data-testid="taoffice-project-task" data-uid={task.uid} data-summary={task.summary}
    data-start={task.start} data-finish={task.finish} data-critical={task.critical}>
    <th scope="row" style={{ paddingInlineStart: Math.max(0, Math.min(task.outline - 1, 8)) * 12 + 8 }}>
      {editing ? <input ref={nameField} type="text" className="taomni-input" data-testid="taoffice-project-task-name"
        aria-label={label("任务名称", "Task name")} aria-invalid={!input.trim()}
        maxLength={MAX_TASK_NAME} value={input} onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || (event.key !== "Enter" && event.key !== "Escape")) return;
          event.preventDefault();
          event.stopPropagation();
          if (event.key === "Enter") {
            if (!input.trim()) return;
            draft.edit(task.uid, input, task.name);
          }
          focusEditButton.current = true;
          setEditing(false);
        }} /> : editable ? <button type="button" className="taomni-btn" ref={editButton}
          data-testid="taoffice-project-rename" disabled={draft.saving} title={label("重命名任务", "Rename task")}
          onClick={() => { setInput(name); setEditing(true); }}>{name || label("未命名任务", "Unnamed task")}</button>
        : name || label("未命名任务", "Unnamed task")}
      {details && <button type="button" className="taomni-btn" data-testid="taoffice-project-open-details"
        aria-label={label(`${name} 的详情`, `Details for ${name}`)} disabled={draft.saving}
        onClick={(event) => details(event.currentTarget)}>{label("详情", "Details")}</button>}
    </th>
    <td title={task.start}>{dateLabel(task.start)}</td>
    <td title={task.finish}>{dateLabel(task.finish)}</td>
    <td><ProjectDuration duration={duration} label={label} onApply={editDuration} saving={draft.saving} /></td>
    <td>{task.progress ? task.progress + "%" : "—"}</td>
    <td>{task.predecessors.join(", ") || "—"}</td>
    <td className="taoffice-project-track">
      {bar && <span className="taoffice-project-bar" data-testid="taoffice-project-bar"
        data-milestone={task.milestone} data-critical={task.critical}
        style={{ left: bar.left + "%", width: task.milestone ? undefined : bar.width + "%" }}
        aria-hidden="true" />}
      {task.critical && <span className="taoffice-project-critical" data-testid="taoffice-project-critical"
        title={label("关键任务", "Critical task")}>{label("关键", "Critical")}</span>}
      {task.slack > 0 && <span className="sr-only">{label("总时差（分钟）", "Total slack (minutes)")} {Math.round(task.slack / MINUTE)}</span>}
    </td>
  </tr>;
}
