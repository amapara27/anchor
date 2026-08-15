use super::*;

#[test]
fn parses_thermal_pressure_when_unthrottled() {
    let raw = "Fan: 0\nCPU_Scheduler_Limit\t=\t100\nCPU_Available_CPUs\t=\t10\nCPU_Speed_Limit\t\t=\t100\n";
    assert_eq!(parse_thermal_pressure_pct(raw), Some(100));
}

#[test]
fn parses_thermal_pressure_when_throttled() {
    let raw = "CPU_Speed_Limit\t\t=\t72\n";
    assert_eq!(parse_thermal_pressure_pct(raw), Some(72));
}

#[test]
fn thermal_pressure_degrades_to_none_when_key_missing() {
    assert_eq!(parse_thermal_pressure_pct("No thermal warning level\n"), None);
}

#[test]
fn parses_ac_power() {
    let raw = "Now drawing from 'AC Power'\n -InternalBattery-0 (id=4325761)\t100%; charged; 0:00 remaining present: true\n";
    assert_eq!(parse_on_ac_power(raw), Some(true));
}

#[test]
fn parses_battery_power() {
    let raw = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=4325761)\t87%; discharging; 3:47 remaining present: true\n";
    assert_eq!(parse_on_ac_power(raw), Some(false));
}

#[test]
fn power_source_degrades_to_none_when_unrecognized() {
    assert_eq!(parse_on_ac_power("garbage\n"), None);
}

#[test]
fn parses_uptime_from_boottime() {
    let raw = "{ sec = 1690000000, usec = 123456 } Wed Jul 20 12:00:00 2023\n";
    assert_eq!(parse_uptime_secs(raw, 1690003600), Some(3600));
}

#[test]
fn uptime_degrades_to_none_when_unparseable() {
    assert_eq!(parse_uptime_secs("garbage\n", 1690003600), None);
}

#[test]
fn parses_free_memory_from_vm_stat() {
    let raw = "Mach Virtual Memory Statistics: (page size of 16384 bytes)\n\
               Pages free:                               12345.\n\
               Pages active:                              67890.\n";
    assert_eq!(parse_free_memory_bytes(raw), Some(12345 * 16384));
}

#[test]
fn free_memory_degrades_to_none_when_unparseable() {
    assert_eq!(parse_free_memory_bytes("garbage\n"), None);
}

// This source exists because `pmset -g therm` reports nothing on Apple Silicon,
// so a `None` here would put us back to "unknown" on every benchmark — the
// failure this replaced. Reads the live OS state; no fixture can stand in.
#[test]
fn thermal_level_reads_a_documented_pressure_level() {
    let level = thermal_level().expect("macOS publishes a thermal pressure level");
    assert!(
        matches!(level, 0 | 10 | 20 | 30 | 40),
        "unexpected OSThermalPressureLevel {level}"
    );
}
