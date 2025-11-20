use log::warn;
use serde::{Deserialize, Serialize};

mod fleet_like;
pub use fleet_like::{EnemyFleet, Fleet, FleetLike, Formation};

mod ship;
pub use ship::Ship;

mod status;
pub use status::Range;

mod equipment;
