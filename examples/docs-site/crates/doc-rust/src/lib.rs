//! Pure Rust helpers that documentation authors can reuse from generated cells.
//!
//! This crate is intentionally independent from Astro, Preact, and WebAssembly
//! glue. The generated cell crate depends on it, so examples can share tested
//! Rust code without asking authors to edit TypeScript or layout files.

use serde::Serialize;
use std::error::Error;
use std::fmt;
use std::iter;

/// One point in a logistic map sequence.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SeriesPoint {
    /// Zero-based step index.
    pub n: u32,
    /// Value at this step.
    pub x: f64,
}

/// A plot specification consumed by the documentation runtime.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind")]
pub enum PlotSpec {
    /// A two-dimensional line plot.
    #[serde(rename = "line")]
    Line(LinePlot),
}

/// A two-dimensional line plot.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LinePlot {
    /// Label for the x-axis.
    pub x_label: String,
    /// Label for the y-axis.
    pub y_label: String,
    /// Data points as `[x, y]` pairs.
    pub points: Vec<[f64; 2]>,
}

/// Errors returned by reusable documentation helpers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DocRustError {
    /// A calculation parameter failed validation.
    InvalidParameter(String),
}

impl fmt::Display for DocRustError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidParameter(message) => write!(f, "{message}"),
        }
    }
}

impl Error for DocRustError {}

/// Applies one logistic map step, `x[n + 1] = r * x[n] * (1 - x[n])`.
#[expect(
    clippy::float_arithmetic,
    reason = "the logistic map is a floating-point numerical example"
)]
pub fn logistic_step(r: f64, x: f64) -> f64 {
    r * x * (1.0 - x)
}

/// Builds a logistic map series including the initial point.
pub fn logistic_series(r: f64, x0: f64, steps: u32) -> Result<Vec<SeriesPoint>, DocRustError> {
    validate_logistic_inputs(r, x0, steps)?;

    Ok(iter::successors(
        Some(SeriesPoint { n: 0, x: x0 }),
        move |point| {
            if point.n >= steps {
                None
            } else {
                Some(SeriesPoint {
                    n: point.n.saturating_add(1),
                    x: logistic_step(r, point.x),
                })
            }
        })
    .collect())
}

/// Converts logistic series points into a line plot.
pub fn line_plot(
    points: &[SeriesPoint],
    x_label: impl Into<String>,
    y_label: impl Into<String>,
) -> PlotSpec {
    PlotSpec::Line(LinePlot {
        x_label: x_label.into(),
        y_label: y_label.into(),
        points: points
            .iter()
            .map(|point| [f64::from(point.n), point.x])
            .collect(),
    })
}

fn validate_logistic_inputs(r: f64, x0: f64, steps: u32) -> Result<(), DocRustError> {
    if !r.is_finite() {
        return Err(DocRustError::InvalidParameter(
            "r must be finite".to_owned(),
        ));
    }
    if !(0.0..=4.0).contains(&r) {
        return Err(DocRustError::InvalidParameter(
            "r must be between 0 and 4".to_owned(),
        ));
    }
    if !x0.is_finite() {
        return Err(DocRustError::InvalidParameter(
            "x0 must be finite".to_owned(),
        ));
    }
    if !(0.0..=1.0).contains(&x0) {
        return Err(DocRustError::InvalidParameter(
            "x0 must be between 0 and 1".to_owned(),
        ));
    }
    if steps == 0 || steps > 1_000 {
        return Err(DocRustError::InvalidParameter(
            "steps must be between 1 and 1000".to_owned(),
        ));
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const FLOAT_TOLERANCE: f64 = 1e-12;

    #[expect(
        clippy::float_arithmetic,
        reason = "tests compare floating-point numerical examples with a tolerance"
    )]
    fn assert_close(actual: f64, expected: f64) {
        assert!(
            (actual - expected).abs() < FLOAT_TOLERANCE,
            "expected {expected}, got {actual}",
        );
    }

    #[test]
    fn logistic_step_matches_formula() {
        assert_close(logistic_step(3.2, 0.2), 0.512_000_000_000_000_1);
    }

    #[test]
    fn series_includes_initial_point_and_steps() {
        let points = logistic_series(3.2, 0.2, 3);

        assert_eq!(
            points.as_ref().map(Vec::len),
            Ok(4),
            "series should include the initial point",
        );
        assert_eq!(
            points.as_ref().ok().and_then(|series| series.first()),
            Some(&SeriesPoint { n: 0, x: 0.2 }),
            "first point should be the initial value",
        );
    }

    #[test]
    fn invalid_parameters_return_errors() {
        assert!(
            logistic_series(4.1, 0.2, 10).is_err(),
            "r greater than 4 should be rejected",
        );
        assert!(
            logistic_series(3.2, -0.1, 10).is_err(),
            "negative x0 should be rejected",
        );
        assert!(
            logistic_series(3.2, 0.2, 0).is_err(),
            "zero steps should be rejected",
        );
    }

    #[test]
    fn invalid_parameters_describe_each_failure() {
        assert_eq!(
            logistic_series(f64::NAN, 0.2, 10).map_err(|error| error.to_string()),
            Err("r must be finite".to_owned()),
            "non-finite r should be rejected with a stable message",
        );
        assert_eq!(
            logistic_series(3.2, f64::INFINITY, 10).map_err(|error| error.to_string()),
            Err("x0 must be finite".to_owned()),
            "non-finite x0 should be rejected with a stable message",
        );
        assert_eq!(
            logistic_series(3.2, 0.2, 1_001).map_err(|error| error.to_string()),
            Err("steps must be between 1 and 1000".to_owned()),
            "large step counts should be rejected",
        );
    }

    #[test]
    fn boundary_parameters_are_valid() {
        assert_eq!(
            logistic_series(0.0, 0.0, 1),
            Ok(vec![
                SeriesPoint { n: 0, x: 0.0 },
                SeriesPoint { n: 1, x: 0.0 },
            ]),
            "lower bounds should be accepted",
        );
        assert_eq!(
            logistic_series(4.0, 1.0, 1),
            Ok(vec![
                SeriesPoint { n: 0, x: 1.0 },
                SeriesPoint { n: 1, x: 0.0 },
            ]),
            "upper bounds should be accepted",
        );
    }

    #[test]
    fn line_plot_converts_series_points() {
        assert_eq!(
            line_plot(
                &[
                    SeriesPoint { n: 0, x: 0.2 },
                    SeriesPoint { n: 1, x: 0.512 },
                ],
                "step",
                "value",
            ),
            PlotSpec::Line(LinePlot {
                x_label: "step".to_owned(),
                y_label: "value".to_owned(),
                points: vec![[0.0, 0.2], [1.0, 0.512]],
            }),
            "plot data should keep labels and convert n to f64",
        );
        assert_eq!(
            line_plot(&[], "n", "x"),
            PlotSpec::Line(LinePlot {
                x_label: "n".to_owned(),
                y_label: "x".to_owned(),
                points: Vec::new(),
            }),
            "empty plot data should keep labels",
        );
    }
}
