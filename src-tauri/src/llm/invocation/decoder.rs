use serde_json::Value;

use super::chat::ChatDecoder;
use super::messages::MessagesDecoder;
use super::receipt::ReceiptBuilder;
use super::responses::ResponsesDecoder;
use super::sse::Event;
use super::{InvocationProtocol, InvocationReceipt};

enum ProtocolDecoder {
    Chat(ChatDecoder),
    Responses(ResponsesDecoder),
    Messages(MessagesDecoder),
}

pub(super) struct Decoder {
    protocol: InvocationProtocol,
    state: ProtocolDecoder,
    receipt: ReceiptBuilder,
    terminal: bool,
}

impl Decoder {
    pub fn new(protocol: InvocationProtocol, model: String) -> Self {
        let state = match protocol {
            InvocationProtocol::OpenaiChat => ProtocolDecoder::Chat(ChatDecoder),
            InvocationProtocol::OpenaiResponses => {
                ProtocolDecoder::Responses(ResponsesDecoder::default())
            }
            InvocationProtocol::AnthropicMessages => {
                ProtocolDecoder::Messages(MessagesDecoder::default())
            }
        };
        Self {
            protocol,
            state,
            receipt: ReceiptBuilder::new(model),
            terminal: false,
        }
    }

    pub fn event(&mut self, event: Event, on_text: &mut impl FnMut(&str)) -> Result<(), String> {
        if self.terminal {
            return Err("Invocation event arrived after terminal marker".into());
        }
        if event.kind == "error" {
            return Err("Provider returned an invocation stream error".into());
        }
        self.terminal = match &mut self.state {
            ProtocolDecoder::Chat(chat) => chat.event(&event.data, &mut self.receipt, on_text)?,
            ProtocolDecoder::Responses(responses) => {
                let value = event_value(&event)?;
                let kind = event_kind(&event, &value)?;
                responses.event(kind, &value, &mut self.receipt, on_text)?
            }
            ProtocolDecoder::Messages(messages) => {
                let value = event_value(&event)?;
                let kind = event_kind(&event, &value)?;
                messages.event(kind, &value, &mut self.receipt, on_text)?
            }
        };
        Ok(())
    }

    pub fn json(&mut self, value: &Value, on_text: &mut impl FnMut(&str)) -> Result<(), String> {
        match &mut self.state {
            ProtocolDecoder::Chat(_) => super::chat::json(value, &mut self.receipt, on_text)?,
            ProtocolDecoder::Responses(responses) => {
                responses.final_response(value, &mut self.receipt, on_text)?
            }
            ProtocolDecoder::Messages(_) => {
                super::messages::json(value, &mut self.receipt, on_text)?
            }
        }
        self.terminal = true;
        Ok(())
    }

    pub fn is_terminal(&self) -> bool {
        self.terminal
    }

    pub fn finish(self) -> Result<InvocationReceipt, String> {
        if !self.terminal {
            return Err(match self.protocol {
                InvocationProtocol::OpenaiChat => "Chat stream ended without [DONE]",
                InvocationProtocol::OpenaiResponses => {
                    "Responses stream ended without terminal event"
                }
                InvocationProtocol::AnthropicMessages => {
                    "Messages stream ended without message_stop"
                }
            }
            .into());
        }
        self.receipt.finish()
    }
}

fn event_value(event: &Event) -> Result<Value, String> {
    serde_json::from_str(&event.data).map_err(|_| "Invalid JSON in invocation SSE event".into())
}

fn event_kind<'a>(event: &'a Event, value: &'a Value) -> Result<&'a str, String> {
    let kind = value
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or(&event.kind);
    if kind.is_empty() || (!event.kind.is_empty() && kind != event.kind) {
        Err("Missing or conflicting invocation SSE event type".into())
    } else {
        Ok(kind)
    }
}
