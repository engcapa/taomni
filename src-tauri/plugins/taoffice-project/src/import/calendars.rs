use super::Xml;
use chrono::{NaiveDate, Weekday};
use mpxj::{
    DayType, ProjectCalendarException, ProjectCalendarHours, ProjectFile, RecurrenceType,
    RecurringData,
};

const WEEKDAYS: [Weekday; 7] = [
    Weekday::Sun,
    Weekday::Mon,
    Weekday::Tue,
    Weekday::Wed,
    Weekday::Thu,
    Weekday::Fri,
    Weekday::Sat,
];

fn working_times(xml: &mut Xml, hours: &ProjectCalendarHours) {
    xml.open("WorkingTimes");
    for time in hours.iter() {
        if let (Some(from), Some(to)) = (time.get_start(), time.get_end()) {
            xml.open("WorkingTime");
            xml.field("FromTime", from.format("%H:%M:%S"));
            xml.field("ToTime", to.format("%H:%M:%S"));
            xml.close("WorkingTime");
        }
    }
    xml.close("WorkingTimes");
}

fn week_days<'a>(
    xml: &mut Xml,
    day_type: impl Fn(Weekday) -> Option<DayType>,
    hours: impl Fn(Weekday) -> Option<&'a ProjectCalendarHours>,
) {
    xml.open("WeekDays");
    for day in WEEKDAYS {
        let working = match day_type(day) {
            Some(DayType::Working) => true,
            Some(DayType::NonWorking) => false,
            _ => continue,
        };
        xml.open("WeekDay");
        xml.field("DayType", day.number_from_sunday());
        xml.flag("DayWorking", working);
        if working && let Some(hours) = hours(day) {
            working_times(xml, hours);
        }
        xml.close("WeekDay");
    }
    xml.close("WeekDays");
}

fn time_period(xml: &mut Xml, start: NaiveDate, finish: NaiveDate) {
    xml.open("TimePeriod");
    xml.date("FromDate", start.and_hms_opt(0, 0, 0));
    xml.date("ToDate", finish.and_hms_opt(23, 59, 0));
    xml.close("TimePeriod");
}

fn recurrence(xml: &mut Xml, data: &RecurringData) {
    let relative = data.get_relative();
    let kind = match data.get_recurrence_type() {
        Some(RecurrenceType::Daily) if data.get_working_days_only() => 7,
        Some(RecurrenceType::Daily) => 1,
        Some(RecurrenceType::Weekly) => 6,
        Some(RecurrenceType::Monthly) if relative => 5,
        Some(RecurrenceType::Monthly) => 4,
        Some(RecurrenceType::Yearly) if relative => 3,
        Some(RecurrenceType::Yearly) => 2,
        None => 0,
    };
    xml.field("Type", kind);
    xml.optional("Period", data.get_frequency());
    if kind == 6 {
        let days = WEEKDAYS
            .iter()
            .filter(|&&day| data.get_weekly_day(day))
            .fold(0u32, |days, day| days | 1 << day.num_days_from_sunday());
        xml.field("DaysOfWeek", days);
    }
    if relative {
        xml.optional(
            "MonthItem",
            data.get_day_of_week()
                .map(|day| day.number_from_sunday() + 2),
        );
        xml.optional(
            "MonthPosition",
            data.get_day_number().filter(|&n| n > 0).map(|n| n - 1),
        );
    } else if matches!(kind, 2 | 4) {
        xml.optional("MonthDay", data.get_day_number());
    }
    if matches!(kind, 2 | 3) {
        xml.optional(
            "Month",
            data.get_month_number().filter(|&n| n > 0).map(|n| n - 1),
        );
    }
}

fn write_exception(xml: &mut Xml, exception: &ProjectCalendarException) {
    let (Some(start), Some(finish)) = (exception.get_from_date(), exception.get_to_date()) else {
        return;
    };
    xml.open("Exception");
    let recurring = exception.get_recurring();
    xml.flag(
        "EnteredByOccurrences",
        recurring.is_some_and(|data| !data.get_use_end_date()),
    );
    time_period(xml, start, finish);
    xml.optional(
        "Occurrences",
        recurring.and_then(RecurringData::get_occurrences),
    );
    xml.optional("Name", exception.get_name());
    if let Some(data) = recurring {
        recurrence(xml, data);
    }
    xml.flag("DayWorking", exception.get_working());
    working_times(xml, exception.get_hours());
    xml.close("Exception");
}

pub(super) fn write_calendars(
    xml: &mut Xml,
    project: &ProjectFile,
    check_current: &mut impl FnMut() -> Result<(), String>,
) -> Result<(), String> {
    xml.open("Calendars");
    for calendar in project.get_calendars_for_project() {
        check_current()?;
        let mut calendar = calendar.borrow_mut();
        let Some(uid) = calendar.get_unique_id() else {
            continue;
        };
        let base = calendar.get_parent_unique_id();
        xml.open("Calendar");
        xml.field("UID", uid);
        xml.optional("Name", calendar.get_name());
        xml.flag("IsBaseCalendar", base.is_none());
        xml.field("BaseCalendarUID", base.unwrap_or(-1));
        week_days(
            xml,
            |day| calendar.get_calendar_day_type(day),
            |day| calendar.get_calendar_hours_for_day(day),
        );
        xml.open("Exceptions");
        for exception in calendar.get_calendar_exceptions() {
            check_current()?;
            write_exception(xml, exception);
            xml.check_size()?;
        }
        xml.close("Exceptions");
        xml.open("WorkWeeks");
        for week in calendar.get_work_weeks() {
            check_current()?;
            let Some(period) = week.get_date_range() else {
                continue;
            };
            let (Some(start), Some(finish)) = (period.get_start(), period.get_end()) else {
                continue;
            };
            xml.open("WorkWeek");
            time_period(xml, start, finish);
            xml.optional("Name", week.get_name());
            week_days(
                xml,
                |day| week.get_calendar_day_type(day),
                |day| week.get_calendar_hours_for_day(day),
            );
            xml.close("WorkWeek");
            xml.check_size()?;
        }
        xml.close("WorkWeeks");
        xml.close("Calendar");
        xml.check_size()?;
    }
    xml.close("Calendars");
    Ok(())
}
