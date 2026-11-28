use chrono::NaiveDateTime;
use mpxj::project_entity_with_id::ProjectEntityWithID;
use mpxj::project_entity_with_unique_id::ProjectEntityWithUniqueID;
use mpxj::{
    Duration, ProjectFile, ProjectProperties, ResourceType, ScheduleFrom, Task, TaskMode, TimeUnit,
};
use std::{fmt::Display, io::Cursor};

mod calendars;
mod mpx;
#[cfg(test)]
mod tests;

pub const MAX_BYTES: usize = 8 * 1024 * 1024;
const UNASSIGNED_RESOURCE_UID: i32 = -65_535;

pub fn import_to_mspdi(
    bytes: &[u8],
    mut check_current: impl FnMut() -> Result<(), String>,
) -> Result<Vec<u8>, String> {
    if bytes.len() > MAX_BYTES {
        return Err("Project previews are limited to 8 MiB".into());
    }
    check_current()?;
    let mut input = Cursor::new(bytes);
    let project = if bytes.starts_with(b"MPX") {
        let mut reader = mpxj::mpx::mpx_reader::MPXReader::new();
        reader.set_locale(mpx::locale(bytes));
        reader.read(&mut input)
    } else {
        let mut reader = mpxj::mpp::mpp_reader::MPPReader::new();
        reader.set_read_presentation_data(false);
        reader.read_stream(&mut input)
    }
    .map_err(|error| error.to_string())?;
    write_project(&project.borrow(), &mut check_current)
}

#[derive(Default)]
struct Xml(String);

impl Xml {
    fn open(&mut self, tag: &str) {
        self.0.push('<');
        self.0.push_str(tag);
        self.0.push('>');
    }

    fn close(&mut self, tag: &str) {
        self.0.push_str("</");
        self.0.push_str(tag);
        self.0.push('>');
    }

    fn field(&mut self, tag: &str, value: impl Display) {
        let value: String = value
            .to_string()
            .chars()
            .map(|character| match character {
                '\u{0}'..='\u{8}'
                | '\u{b}'..='\u{c}'
                | '\u{e}'..='\u{1f}'
                | '\u{fffe}'
                | '\u{ffff}' => '\u{fffd}',
                allowed => allowed,
            })
            .collect();
        self.open(tag);
        self.0.push_str(&quick_xml::escape::escape(value));
        self.close(tag);
    }

    fn optional(&mut self, tag: &str, value: Option<impl Display>) {
        if let Some(value) = value {
            self.field(tag, value);
        }
    }

    fn date(&mut self, tag: &str, value: Option<NaiveDateTime>) {
        self.optional(
            tag,
            value
                .map(|date| date.format("%Y-%m-%dT%H:%M:%S"))
                .map(|value| value.to_string()),
        );
    }

    fn flag(&mut self, tag: &str, value: bool) {
        self.field(tag, u8::from(value));
    }

    fn check_size(&self) -> Result<(), String> {
        if self.0.len() > MAX_BYTES {
            return Err("The converted project exceeds 8 MiB".into());
        }
        Ok(())
    }
}

fn minutes(duration: Duration, properties: &ProjectProperties) -> f64 {
    let unit = if duration.get_units().is_elapsed() {
        TimeUnit::ElapsedMinutes
    } else {
        TimeUnit::Minutes
    };
    duration.convert_units(unit, properties).get_duration()
}

fn duration_text(duration: Duration, properties: &ProjectProperties) -> Option<String> {
    let seconds = (minutes(duration, properties) * 60.0).round();
    if !seconds.is_finite() || seconds < 0.0 || seconds > 316_224_000.0 {
        return None;
    }
    let seconds = seconds as u64;
    Some(format!(
        "PT{}H{}M{}S",
        seconds / 3600,
        seconds / 60 % 60,
        seconds % 60
    ))
}

fn write_task(xml: &mut Xml, task: &Task, uid: i32, properties: &ProjectProperties) {
    xml.open("Task");
    xml.field("UID", uid);
    xml.optional("ID", task.get_id());
    xml.optional("Name", task.get_name());
    xml.flag("Active", task.get_active());
    xml.flag(
        "Manual",
        task.get_task_mode() == Some(TaskMode::ManuallyScheduled),
    );
    xml.optional("OutlineLevel", task.get_outline_level());
    xml.date("Start", task.get_start());
    xml.date("Finish", task.get_finish());
    if let Some(duration) = task.get_duration() {
        xml.optional("Duration", duration_text(duration, properties));
        xml.field(
            "DurationFormat",
            if duration.get_units().is_elapsed() {
                6
            } else {
                5
            },
        );
    }
    xml.optional(
        "Work",
        task.get_work()
            .and_then(|value| duration_text(value, properties)),
    );
    xml.flag("Milestone", task.get_milestone());
    xml.flag("Summary", task.get_summary());
    xml.flag("Critical", task.get_critical());
    xml.date("EarlyStart", task.get_early_start());
    xml.date("EarlyFinish", task.get_early_finish());
    xml.date("LateStart", task.get_late_start());
    xml.date("LateFinish", task.get_late_finish());
    xml.optional(
        "TotalSlack",
        task.get_total_slack()
            .map(|value| (minutes(value, properties) * 10.0).round() as i64),
    );
    xml.optional(
        "PercentComplete",
        task.get_percentage_complete()
            .map(|value| value.clamp(0.0, 100.0).round() as u8),
    );
    xml.date("ActualStart", task.get_actual_start());
    xml.date("ActualFinish", task.get_actual_finish());
    xml.optional(
        "ConstraintType",
        task.get_constraint_type()
            .map(|constraint| constraint as u8),
    );
    xml.optional("CalendarUID", task.get_calendar_unique_id());
    xml.date("ConstraintDate", task.get_constraint_date());
    xml.flag(
        "IgnoreResourceCalendar",
        task.get_ignore_resource_calendar(),
    );
    let notes = task.get_notes();
    if !notes.is_empty() {
        xml.field("Notes", notes);
    }
    for relation in task.get_predecessors() {
        let relation = relation.borrow();
        let Some(uid) = relation
            .get_predecessor_task()
            .and_then(|task| task.borrow().get_unique_id())
        else {
            continue;
        };
        xml.open("PredecessorLink");
        xml.field("PredecessorUID", uid);
        xml.field("Type", relation.get_type() as u8);
        if let Some(lag) = relation.get_lag() {
            let units = lag.get_units();
            let (value, format) = match units {
                TimeUnit::Percent => (lag.get_duration(), 19),
                TimeUnit::ElapsedPercent => (lag.get_duration(), 20),
                _ => (
                    minutes(lag, properties) * 10.0,
                    if units.is_elapsed() { 4 } else { 3 },
                ),
            };
            xml.field("LinkLag", value.round() as i64);
            xml.field("LagFormat", format);
        }
        xml.close("PredecessorLink");
    }
    for number in 0..=10 {
        let start = task.get_baseline_start_at(number);
        let finish = task.get_baseline_finish_at(number);
        let duration = task
            .get_baseline_duration_at(number)
            .and_then(|value| duration_text(value, properties));
        if start.is_some() || finish.is_some() || duration.is_some() {
            xml.open("Baseline");
            xml.field("Number", number);
            xml.date("Start", start);
            xml.date("Finish", finish);
            xml.optional("Duration", duration);
            xml.close("Baseline");
        }
    }
    xml.close("Task");
}

fn write_project(
    project: &ProjectFile,
    check_current: &mut impl FnMut() -> Result<(), String>,
) -> Result<Vec<u8>, String> {
    if project.get_tasks().len() > 10_000 {
        return Err("Project preview is limited to 10,000 tasks".into());
    }
    let properties = project.get_project_properties();
    let mut xml = Xml("<?xml version=\"1.0\" encoding=\"UTF-8\"?><Project xmlns=\"http://schemas.microsoft.com/project\">".into());
    xml.optional(
        "Name",
        properties
            .get_project_title()
            .or_else(|| properties.get_name()),
    );
    xml.flag(
        "ScheduleFromStart",
        properties.get_schedule_from() == ScheduleFrom::Start,
    );
    xml.date("StartDate", properties.get_start_date());
    xml.date("FinishDate", properties.get_finish_date());
    xml.optional("CurrencyCode", properties.get_currency_code());
    xml.optional("CalendarUID", properties.get_default_calendar_unique_id());
    xml.optional("MinutesPerDay", properties.get_minutes_per_day());
    xml.optional("MinutesPerWeek", properties.get_minutes_per_week());
    xml.optional("DaysPerMonth", properties.get_days_per_month());
    calendars::write_calendars(&mut xml, project, check_current)?;

    xml.open("Tasks");
    for task in project.get_tasks().iter() {
        check_current()?;
        let task = task.borrow();
        if let Some(uid) = task.get_unique_id().filter(|uid| *uid >= 0) {
            write_task(&mut xml, &task, uid, properties);
            xml.check_size()?;
        }
    }
    xml.close("Tasks");

    xml.open("Resources");
    for resource in project.get_resources().iter() {
        check_current()?;
        let resource = resource.borrow();
        let Some(uid) = resource.get_unique_id() else {
            continue;
        };
        xml.open("Resource");
        xml.field("UID", uid);
        xml.optional("ID", resource.get_id());
        xml.optional("Name", resource.get_name());
        xml.field(
            "Type",
            match resource.get_type() {
                ResourceType::Material => 0,
                ResourceType::Work | ResourceType::NonLabor => 1,
                ResourceType::Cost => 2,
            },
        );
        xml.date("Start", resource.get_start());
        xml.date("Finish", resource.get_finish());
        xml.optional(
            "Work",
            resource
                .get_work()
                .and_then(|value| duration_text(value, properties)),
        );
        xml.optional("CalendarUID", resource.get_calendar_unique_id());
        let notes = resource.get_notes();
        xml.optional("Notes", (!notes.is_empty()).then_some(notes));
        xml.close("Resource");
        xml.check_size()?;
    }
    xml.close("Resources");

    xml.open("Assignments");
    for assignment in project.get_resource_assignments().iter() {
        check_current()?;
        let assignment = assignment.borrow();
        let (Some(uid), Some(task)) = (assignment.get_unique_id(), assignment.get_task_unique_id())
        else {
            continue;
        };
        xml.open("Assignment");
        xml.field("UID", uid);
        xml.field("TaskUID", task);
        xml.field(
            "ResourceUID",
            assignment
                .get_resource_unique_id()
                .unwrap_or(UNASSIGNED_RESOURCE_UID),
        );
        xml.date("ActualFinish", assignment.get_actual_finish());
        xml.date("ActualStart", assignment.get_actual_start());
        xml.date("Finish", assignment.get_finish());
        let notes = assignment.get_notes();
        xml.optional("Notes", (!notes.is_empty()).then_some(notes));
        xml.date("Start", assignment.get_start());
        xml.optional(
            "Units",
            assignment
                .get_units()
                .filter(|percent| percent.is_finite())
                .map(|percent| percent / 100.0),
        );
        xml.optional(
            "Work",
            assignment
                .get_work()
                .and_then(|value| duration_text(value, properties)),
        );
        xml.close("Assignment");
        xml.check_size()?;
    }
    xml.close("Assignments");
    xml.close("Project");
    xml.check_size()?;
    Ok(xml.0.into_bytes())
}
