mod groups;

mod rotation;

mod routing;

mod construction;

#[cfg(test)]
mod capability_tests;

pub use groups::{PROVIDER_GROUP_PREFIX, provider_group_id_from_route, provider_group_route_id};

pub use routing::{FallbackConfig, LlmRouter};

pub use construction::{
    build_router, build_router_from_ai, build_router_from_ai_with_proxy_db,
    build_router_with_proxy_db,
};
