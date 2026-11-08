#[derive(serde::Serialize)]
pub struct Point {
    pub x: i32,
}

pub fn point(x: i32) -> Point {
    Point { x }
}
