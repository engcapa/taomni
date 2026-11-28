const { React } = globalThis.__taomniHost;
const { useId, useLayoutEffect, useRef, useState } = React;

const LINK_TYPES = [
  ["完成到完成（FF）", "Finish to finish (FF)"],
  ["完成到开始（FS）", "Finish to start (FS)"],
  ["开始到完成（SF）", "Start to finish (SF)"],
  ["开始到开始（SS）", "Start to start (SS)"],
];
const LAG_UNITS = [
  ["workingHours", "工作小时", "Working hours"],
  ["elapsedHours", "自然小时", "Elapsed hours"],
  ["durationPercent", "工期百分比", "Duration percent"],
  ["elapsedPercent", "自然工期百分比", "Elapsed duration percent"],
];
const defaultLink = { uid: "", type: "1", lag: "0", lagUnit: "workingHours" };
const defaultAssignment = { resource: "", units: "100" };
const localDate = (value) => value?.slice(0, 19) ?? "";

export function ProjectDetails({ task, details, tasks, resources, change, close, canSchedule, saving, label }) {
  const heading = useId();
  const panel = useRef(null);
  const cancelDelete = useRef(null);
  const removeButton = useRef(null);
  const [confirm, setConfirm] = useState(false);
  const [start, setStart] = useState(localDate(details.start));
  const [finish, setFinish] = useState(localDate(details.finish));
  const [progress, setProgress] = useState(details.progress);
  const [link, setLink] = useState(defaultLink);
  const [assignment, setAssignment] = useState(defaultAssignment);
  useLayoutEffect(() => { panel.current?.focus(); }, []);
  useLayoutEffect(() => { if (confirm) cancelDelete.current?.focus(); }, [confirm]);
  useLayoutEffect(() => {
    setStart(localDate(details.start));
    setFinish(localDate(details.finish));
    setProgress(details.progress);
  }, [details.start, details.finish, details.progress]);

  function cancelRemove() {
    setConfirm(false);
    removeButton.current?.focus();
  }

  function submit(event, value, done) {
    event.preventDefault();
    if (change(value)) done?.();
  }

  return <section ref={panel} tabIndex={-1} aria-labelledby={heading} className="taoffice-project-details"
    data-testid="taoffice-project-details" onKeyDown={(event) => {
      if (event.key !== "Escape" || event.nativeEvent.isComposing || event.keyCode === 229) return;
      event.preventDefault();
      event.stopPropagation();
      if (confirm) cancelRemove();
      else close();
    }}>
    <div className="taoffice-project-details-header">
      <h3 id={heading}>{task.name}</h3>
      <button type="button" className="taomni-btn" onClick={close}>{label("关闭任务详情", "Close task details")}</button>
    </div>
    {!task.summary && <>
      <form className="taoffice-project-detail-fields" onSubmit={(event) => submit(event, { kind: "dates", start, finish })}>
        <label>{label("开始日期", "Start date")}<input className="taomni-input" type="datetime-local" step="1"
          value={start} required disabled={saving || !canSchedule} data-testid="taoffice-project-task-start"
          onChange={(event) => setStart(event.target.value)} /></label>
        <label>{label("完成日期", "Finish date")}<input className="taomni-input" type="datetime-local" step="1"
          value={finish} required disabled={saving || !canSchedule} data-testid="taoffice-project-task-finish"
          onChange={(event) => setFinish(event.target.value)} /></label>
        <button type="submit" className="taomni-btn" data-testid="taoffice-project-apply-dates" disabled={saving || !canSchedule}>
          {label("应用日期", "Apply dates")}
        </button>
      </form>
      <form className="taoffice-project-detail-fields" onSubmit={(event) => submit(event, { kind: "progress", progress })}>
        <label>{label("完成百分比", "Percent complete")}<input className="taomni-input" type="number" min="0" max="100" step="1"
          value={progress} required disabled={saving} data-testid="taoffice-project-task-progress"
          onChange={(event) => setProgress(event.target.value)} /></label>
        <button type="submit" className="taomni-btn" data-testid="taoffice-project-apply-progress" disabled={saving}>
          {label("应用进度", "Apply progress")}
        </button>
      </form>
      <fieldset disabled={saving || !canSchedule}>
        <legend>{label("前置任务", "Predecessors")}</legend>
        {details.links.length > 0 && <ul data-testid="taoffice-project-task-links">
          {details.links.map((item) => <li key={item.uid}>
            {tasks.find((entry) => entry.uid === item.uid)?.name ?? item.uid} · {label(...(LINK_TYPES[item.type] ?? LINK_TYPES[1]))}
            <button className="taomni-btn" type="button" onClick={() => setLink({ ...item, originalUid: item.uid })}>
              {label("编辑依赖", "Edit link")}
            </button>
            <button className="taomni-btn" type="button" onClick={() => {
              if (change({ kind: "removeLink", originalUid: item.uid })) setLink(defaultLink);
            }}>{label("移除依赖", "Remove link")}</button>
          </li>)}
        </ul>}
        <form className="taoffice-project-detail-fields"
          onSubmit={(event) => submit(event, { kind: "link", ...link }, () => setLink(defaultLink))}>
          <label>{label("任务", "Task")}<select className="taomni-input" data-testid="taoffice-project-predecessor"
            required value={link.uid} onChange={(event) => setLink({ ...link, uid: event.target.value })}>
            <option value="">{label("选择任务", "Select task")}</option>
            {tasks.filter((entry) => entry.uid !== task.uid && !entry.summary)
              .map((entry) => <option key={entry.uid} value={entry.uid}>{entry.name}</option>)}
          </select></label>
          <label>{label("依赖类型", "Link type")}<select className="taomni-input" data-testid="taoffice-project-link-type"
            value={link.type} onChange={(event) => setLink({ ...link, type: event.target.value })}>
            {LINK_TYPES.map((type, index) => <option value={index} key={index}>{label(...type)}</option>)}
          </select></label>
          <label>{label("时差", "Lag")}<input type="number" className="taomni-input" required step="any"
            value={link.lag} data-testid="taoffice-project-link-lag" onChange={(event) => setLink({ ...link, lag: event.target.value })} /></label>
          <label>{label("时差单位", "Lag unit")}<select className="taomni-input" data-testid="taoffice-project-link-lag-unit"
            value={link.lagUnit} onChange={(event) => setLink({ ...link, lagUnit: event.target.value })}>
            {LAG_UNITS.map(([value, zh, en]) => <option key={value} value={value}>{label(zh, en)}</option>)}
          </select></label>
          <button type="submit" className="taomni-btn" data-testid="taoffice-project-apply-link" disabled={!link.uid}>
            {link.originalUid ? label("更新依赖", "Update link") : label("添加依赖", "Add link")}
          </button>
        </form>
      </fieldset>
      <fieldset disabled={saving || !canSchedule}>
        <legend>{label("资源分配", "Resource assignments")}</legend>
        {details.assignments.length > 0 && <ul data-testid="taoffice-project-task-assignments">
          {details.assignments.map((item) => <li key={item.uid}>
            {resources.find((entry) => entry.uid === item.resource)?.name ?? item.resource} · {Number(item.units.toFixed(2))}%
            <button className="taomni-btn" type="button" onClick={() => setAssignment({ ...item, originalUid: item.uid })}>
              {label("编辑分配", "Edit assignment")}
            </button>
            <button className="taomni-btn" type="button" onClick={() => {
              if (change({ kind: "removeAssignment", originalUid: item.uid })) setAssignment(defaultAssignment);
            }}>{label("移除分配", "Remove assignment")}</button>
          </li>)}
        </ul>}
        <form className="taoffice-project-detail-fields"
          onSubmit={(event) => submit(event, { kind: "assignment", ...assignment }, () => setAssignment(defaultAssignment))}>
          <label>{label("资源", "Resource")}<select className="taomni-input" data-testid="taoffice-project-resource"
            required value={assignment.resource} onChange={(event) => setAssignment({ ...assignment, resource: event.target.value })}>
            <option value="">{label("选择资源", "Select resource")}</option>
            {resources.map((entry) => <option key={entry.uid} value={entry.uid}>{entry.name}</option>)}
          </select></label>
          <label>{label("分配比例（%）", "Allocation (%)")}<input className="taomni-input" type="number" min="0.01" max="10000"
            step="any" required value={assignment.units} data-testid="taoffice-project-resource-units"
            onChange={(event) => setAssignment({ ...assignment, units: event.target.value })} /></label>
          <button type="submit" className="taomni-btn" data-testid="taoffice-project-apply-resource" disabled={!assignment.resource}>
            {assignment.originalUid ? label("更新分配", "Update assignment") : label("分配资源", "Assign resource")}
          </button>
        </form>
      </fieldset>
    </>}
    <div className="taoffice-project-detail-fields">
      <button type="button" className="taomni-btn" ref={removeButton} data-testid="taoffice-project-remove-task"
        disabled={saving} onClick={() => setConfirm(true)}>{label("删除任务", "Remove task")}</button>
      {confirm && <>
        <p role="status">{task.summary ? label("删除此摘要及其所有子任务？", "Remove this summary and its subtasks?")
          : label("删除此任务及其依赖和资源分配？", "Remove this task and its links and assignments?")}</p>
        <button type="button" className="taomni-btn" ref={cancelDelete} onClick={cancelRemove}>{label("取消", "Cancel")}</button>
        <button type="button" className="taomni-btn" data-variant="danger" data-testid="taoffice-project-confirm-remove"
          disabled={saving} onClick={() => change({ kind: "removeTask" })}>{label("确认删除", "Confirm removal")}</button>
      </>}
    </div>
  </section>;
}

export function ProjectNewTask({ change, close, saving, label }) {
  const [name, setName] = useState("");
  const input = useRef(null);
  useLayoutEffect(() => { input.current?.focus(); }, []);
  return <form className="taoffice-project-detail-fields taoffice-project-new-task" onSubmit={(event) => {
    event.preventDefault();
    if (change({ kind: "addTask", name })) setName("");
  }} onKeyDown={(event) => {
    if (event.key !== "Escape" || event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.stopPropagation();
    event.preventDefault();
    close();
  }}>
    <label>{label("任务名称", "Task name")}<input className="taomni-input" ref={input}
      required maxLength={255} data-testid="taoffice-project-new-name" value={name}
      onChange={(event) => setName(event.target.value)} /></label>
    <button type="submit" className="taomni-btn" data-testid="taoffice-project-create-task" disabled={saving || !name.trim()}>
      {label("创建任务", "Create task")}
    </button>
    <button type="button" className="taomni-btn" onClick={close}>{label("取消", "Cancel")}</button>
  </form>;
}
