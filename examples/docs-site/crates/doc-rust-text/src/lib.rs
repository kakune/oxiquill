//! Small text helpers that documentation authors can reuse from generated cells.

use std::fmt::Display;

/// Formats a label and value as a compact output line.
pub fn labeled_value(label: &str, value: impl Display) -> String {
    format!("{label}: {value}")
}

/// Returns a stable note for a display style selected by a cell control.
pub fn style_note(style: &str) -> &'static str {
    match style {
        "verbose" => "verbose output includes explanatory labels",
        _ => "compact output keeps only the essentials",
    }
}

#[cfg(test)]
mod tests {
    use super::{labeled_value, style_note};

    #[test]
    fn labeled_value_formats_display_values() {
        assert_eq!(
            labeled_value("answer", 42),
            "answer: 42",
            "label and value should be separated by a colon",
        );
    }

    #[test]
    fn style_note_describes_known_and_default_styles() {
        assert_eq!(
            style_note("verbose"),
            "verbose output includes explanatory labels",
            "verbose style should use the detailed note",
        );
        assert_eq!(
            style_note("compact"),
            "compact output keeps only the essentials",
            "unknown or compact styles should use the compact note",
        );
    }
}
