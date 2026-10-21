mod transport;

mod connection;

mod authentication;

mod configuration;

#[cfg(test)]
mod tests;

pub use transport::MISSING_JUMP_PASSWORD_ERROR;

pub(crate) use transport::{SshTransport, build_ssh_transport};

pub use connection::{
    SshHandler, SshSession, SshStartupCommand, connect_ssh, connect_ssh_authenticated,
    connect_ssh_authenticated_with, connect_ssh_authenticated_with_prompter,
};

pub use authentication::{KbdInteractivePrompter, KbdInteractiveRequest, KbdPrompt, SshAuth};
