// Copyright 2020-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! Keep first-navigation evaluations and their completion callbacks together.
//! The navigation delegate drains once; later evaluations run immediately.

pub(crate) type EvaluationCallback = Box<dyn Fn(String) + Send + 'static>;

pub(crate) struct ScriptEvaluation {
  pub script: String,
  pub callback: Option<EvaluationCallback>,
}

pub(crate) struct PendingScripts {
  entries: Option<Vec<ScriptEvaluation>>,
}

impl Default for PendingScripts {
  fn default() -> Self {
    Self {
      entries: Some(Vec::new()),
    }
  }
}

impl PendingScripts {
  pub fn queue_or_ready(&mut self, evaluation: ScriptEvaluation) -> Option<ScriptEvaluation> {
    if let Some(entries) = &mut self.entries {
      entries.push(evaluation);
      None
    } else {
      Some(evaluation)
    }
  }

  pub fn take_initial(&mut self) -> Vec<ScriptEvaluation> {
    self.entries.take().unwrap_or_default()
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::{mpsc, Arc, Mutex};

  #[test]
  fn a_pre_navigation_callback_receives_the_actual_evaluation_result_once() {
    let (sender, receiver) = mpsc::channel();
    let mut queue = PendingScripts::default();
    assert!(queue
      .queue_or_ready(ScriptEvaluation {
        script: "document.readyState".into(),
        callback: Some(Box::new(move |value| sender.send(value).unwrap())),
      })
      .is_none());
    assert!(receiver.try_recv().is_err());
    let evaluations = queue.take_initial();
    assert_eq!(evaluations.len(), 1);
    for evaluation in evaluations {
      assert_eq!(evaluation.script, "document.readyState");
      evaluation.callback.unwrap()("\"interactive\"".into());
    }
    assert_eq!(receiver.try_recv().unwrap(), "\"interactive\"");
    assert!(queue.take_initial().is_empty());
    assert!(receiver.try_recv().is_err());
  }

  #[test]
  fn mixed_evaluations_keep_fifo_order_and_each_callback_stays_with_its_script() {
    let (sender, receiver) = mpsc::channel();
    let mut queue = PendingScripts::default();
    for script in ["first", "no callback", "last"] {
      let callback = (script != "no callback").then(|| {
        let sender = sender.clone();
        Box::new(move |value| sender.send((script, value)).unwrap()) as EvaluationCallback
      });
      assert!(queue
        .queue_or_ready(ScriptEvaluation {
          script: script.into(),
          callback
        })
        .is_none());
    }
    let evaluations = queue.take_initial();
    assert_eq!(
      evaluations
        .iter()
        .map(|entry| entry.script.as_str())
        .collect::<Vec<_>>(),
      ["first", "no callback", "last"]
    );
    for evaluation in evaluations {
      if let Some(callback) = evaluation.callback {
        callback(evaluation.script);
      }
    }
    assert_eq!(
      receiver.try_iter().collect::<Vec<_>>(),
      [("first", "first".into()), ("last", "last".into())]
    );
  }

  #[test]
  fn evaluations_after_the_first_commit_are_ready_with_the_original_callback() {
    let mut queue = PendingScripts::default();
    assert!(queue.take_initial().is_empty());
    let (sender, receiver) = mpsc::channel();
    let ready = queue
      .queue_or_ready(ScriptEvaluation {
        script: "after navigation".into(),
        callback: Some(Box::new(move |value| sender.send(value).unwrap())),
      })
      .expect("committed documents evaluate immediately");
    assert_eq!(ready.script, "after navigation");
    ready.callback.unwrap()("null".into());
    assert_eq!(receiver.try_recv().unwrap(), "null");
    assert!(queue.take_initial().is_empty());
  }

  #[test]
  fn destroying_an_uncommitted_webview_releases_callbacks_with_a_retained_delegate() {
    let owner = Arc::new(());
    let callback_owner = owner.clone();
    let queue = Arc::new(Mutex::new(PendingScripts::default()));
    let delegate_queue = queue.clone();
    assert!(queue
      .lock()
      .unwrap()
      .queue_or_ready(ScriptEvaluation {
        script: "never committed".into(),
        callback: Some(Box::new(move |_| {
          let _keep_alive = &callback_owner;
        })),
      })
      .is_none());
    assert_eq!(Arc::strong_count(&owner), 2);
    let pending = queue.lock().unwrap().take_initial();
    drop(pending);
    drop(queue);
    assert_eq!(Arc::strong_count(&owner), 1);
    assert!(delegate_queue.lock().unwrap().take_initial().is_empty());
  }
}
