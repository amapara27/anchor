use super::*;

const APPLE_SILICON: &str = r#"{
  "SPHardwareDataType": [{
    "machine_name": "MacBook Pro",
    "chip_type": "Apple M3 Pro",
    "physical_memory": "18 GB",
    "number_processors": "proc 11:5:6"
  }],
  "SPSoftwareDataType": [{ "os_version": "macOS 15.5 (24F74)" }],
  "SPDisplaysDataType": [{
    "_name": "Apple M3 Pro",
    "sppci_bus": "spdisplays_builtin",
    "sppci_cores": "14",
    "sppci_device_type": "spdisplays_gpu"
  }]
}"#;

#[test]
fn parses_apple_silicon_profile() {
    let p = parse_profile(APPLE_SILICON).unwrap();
    assert_eq!(p.chip.as_deref(), Some("Apple M3 Pro"));
    assert_eq!(p.model_name.as_deref(), Some("MacBook Pro"));
    assert_eq!(p.memory_bytes, Some(18 * 1024 * 1024 * 1024));
    assert_eq!(p.total_cores, Some(11));
    assert_eq!(p.performance_cores, Some(5));
    assert_eq!(p.efficiency_cores, Some(6));
    assert_eq!(p.gpu_cores, Some(14));
    assert_eq!(p.os_version.as_deref(), Some("15.5"));
    // arch / apple_silicon reflect the host running the test, not the fixture.
    assert_eq!(p.apple_silicon, std::env::consts::ARCH == "aarch64");
}

#[test]
fn gpu_cores_prefer_the_builtin_gpu() {
    // An attached eGPU sorts first; the integrated GPU is the one that matters,
    // since it's what runs inference.
    let displays = vec![
        RawDisplay {
            sppci_cores: Some("64".to_string()),
            sppci_bus: Some("spdisplays_pcie_device".to_string()),
        },
        RawDisplay {
            sppci_cores: Some("10".to_string()),
            sppci_bus: Some("spdisplays_builtin".to_string()),
        },
    ];
    assert_eq!(parse_gpu_cores(&displays), Some(10));
}

#[test]
fn gpu_cores_degrade_to_none_when_absent_or_unparseable() {
    assert_eq!(parse_gpu_cores(&[]), None);
    assert_eq!(
        parse_gpu_cores(&[RawDisplay {
            sppci_cores: Some("unknown".to_string()),
            sppci_bus: None,
        }]),
        None
    );
    // No bus field at all: fall back to the first entry that parses.
    assert_eq!(
        parse_gpu_cores(&[RawDisplay {
            sppci_cores: Some("8".to_string()),
            sppci_bus: None,
        }]),
        Some(8)
    );
}

#[test]
fn parses_intel_profile() {
    let json = r#"{
      "SPHardwareDataType": [{
        "machine_name": "MacBook Pro",
        "cpu_type": "Intel Core i7",
        "physical_memory": "16 GB",
        "number_processors": 8
      }],
      "SPSoftwareDataType": [{ "os_version": "macOS 13.6" }]
    }"#;
    let p = parse_profile(json).unwrap();
    assert_eq!(p.chip.as_deref(), Some("Intel Core i7"));
    assert_eq!(p.memory_bytes, Some(16 * 1024 * 1024 * 1024));
    assert_eq!(p.total_cores, Some(8));
    assert_eq!(p.performance_cores, None);
    assert_eq!(p.efficiency_cores, None);
    assert_eq!(p.os_version.as_deref(), Some("13.6"));
}

#[test]
fn parse_memory_bytes_units() {
    assert_eq!(parse_memory_bytes("16 GB"), Some(16 * 1024 * 1024 * 1024));
    assert_eq!(parse_memory_bytes("512 MB"), Some(512 * 1024 * 1024));
    assert_eq!(parse_memory_bytes("1 TB"), Some(1024_u64.pow(4)));
    assert_eq!(parse_memory_bytes("garbage"), None);
    assert_eq!(parse_memory_bytes("16"), None); // no unit
    assert_eq!(parse_memory_bytes("16 PB"), None); // unknown unit
}

#[test]
fn parse_core_counts_proc_string() {
    assert_eq!(parse_core_counts("proc 11:5:6"), (Some(11), Some(5), Some(6)));
    // M4-era chips append a fourth field; the leading three still apply.
    assert_eq!(parse_core_counts("proc 10:4:6:0"), (Some(10), Some(4), Some(6)));
    assert_eq!(parse_core_counts("8"), (Some(8), None, None));
    assert_eq!(parse_core_counts("proc 8"), (Some(8), None, None));
    assert_eq!(parse_core_counts("junk"), (None, None, None));
}

#[test]
fn missing_fields_degrade_to_none() {
    let p = parse_profile(r#"{ "SPHardwareDataType": [{}] }"#).unwrap();
    assert_eq!(p.chip, None);
    assert_eq!(p.memory_bytes, None);
    assert_eq!(p.total_cores, None);
    assert_eq!(p.os_version, None);
    assert_eq!(p.model_name, None);
    assert!(!p.arch.is_empty()); // arch always comes from std::env
}

#[test]
fn os_version_strips_prefix_and_build() {
    assert_eq!(strip_os_version("macOS 15.5 (24F74)").as_deref(), Some("15.5"));
    assert_eq!(strip_os_version("macOS 26.0").as_deref(), Some("26.0"));
    assert_eq!(strip_os_version("").as_deref(), None);
}
