/// Abstract IM channel adapter trait.
///
/// Each messaging platform (Telegram, Discord, Slack, ...) implements this
/// trait so that the core processing loop in `mod.rs` stays channel-agnostic.

/// Result alias with plain String error (channel-specific error types are
/// mapped to String at the impl boundary).
pub type AdapterResult<T> = Result<T, String>;

pub trait ImAdapter: Send + Sync + 'static {
    /// Verify the bot connection and return a human-readable identifier
    /// (e.g. Telegram bot username, Discord bot tag).
    fn verify_connection(
        &self,
    ) -> impl std::future::Future<Output = AdapterResult<String>> + Send;

    /// Register platform-specific commands (e.g. Telegram BotFather menu).
    /// No-op for platforms that don't support command registration.
    fn register_commands(
        &self,
    ) -> impl std::future::Future<Output = AdapterResult<()>> + Send;

    /// Start the message receive loop (long-polling, WebSocket, etc.).
    /// Blocks until `shutdown_rx` signals `true`.
    fn listen_loop(
        &self,
        shutdown_rx: tokio::sync::watch::Receiver<bool>,
    ) -> impl std::future::Future<Output = ()> + Send;

    /// Send a text message to the given chat.
    fn send_message(
        &self,
        chat_id: &str,
        text: &str,
    ) -> impl std::future::Future<Output = AdapterResult<()>> + Send;

    /// React to indicate the message was received (e.g. 👀).
    fn ack_received(
        &self,
        chat_id: &str,
        message_id: &str,
    ) -> impl std::future::Future<Output = ()> + Send;

    /// React to indicate processing has started (e.g. ⏳).
    fn ack_processing(
        &self,
        chat_id: &str,
        message_id: &str,
    ) -> impl std::future::Future<Output = ()> + Send;

    /// Clear acknowledgement reactions.
    fn ack_clear(
        &self,
        chat_id: &str,
        message_id: &str,
    ) -> impl std::future::Future<Output = ()> + Send;

    /// Send a "typing" / "processing" indicator to the chat.
    fn send_typing(
        &self,
        chat_id: &str,
    ) -> impl std::future::Future<Output = ()> + Send;
}

/// Extended adapter trait for platforms that support streaming draft messages.
/// Provides send_message_returning_id, edit_message, and delete_message
/// so the SSE stream loop can manage draft messages generically.
pub trait ImStreamAdapter: ImAdapter {
    /// Send a message and return its ID (for later edit/delete).
    fn send_message_returning_id(
        &self,
        chat_id: &str,
        text: &str,
    ) -> impl std::future::Future<Output = AdapterResult<Option<String>>> + Send;

    /// Edit an existing message by ID.
    fn edit_message(
        &self,
        chat_id: &str,
        message_id: &str,
        text: &str,
    ) -> impl std::future::Future<Output = AdapterResult<()>> + Send;

    /// Delete a message by ID.
    fn delete_message(
        &self,
        chat_id: &str,
        message_id: &str,
    ) -> impl std::future::Future<Output = AdapterResult<()>> + Send;

    /// Max message length for this platform (Telegram: 4096, Feishu: 30000).
    fn max_message_length(&self) -> usize;

    /// Send an interactive approval card/keyboard and return its message ID.
    /// Used for permission requests when the bot runs in non-fullAgency mode.
    fn send_approval_card(
        &self,
        chat_id: &str,
        request_id: &str,
        tool_name: &str,
        tool_input: &str,
    ) -> impl std::future::Future<Output = AdapterResult<Option<String>>> + Send;

    /// Update an approval card/message to show resolved status (approved/denied).
    fn update_approval_status(
        &self,
        chat_id: &str,
        message_id: &str,
        status: &str,
    ) -> impl std::future::Future<Output = AdapterResult<()>> + Send;

    /// Send a photo/image to the given chat. Returns the sent message ID if available.
    fn send_photo(
        &self,
        chat_id: &str,
        data: Vec<u8>,
        filename: &str,
        caption: Option<&str>,
    ) -> impl std::future::Future<Output = AdapterResult<Option<String>>> + Send;

    /// Send a file/document to the given chat. Returns the sent message ID if available.
    fn send_file(
        &self,
        chat_id: &str,
        data: Vec<u8>,
        filename: &str,
        mime_type: &str,
        caption: Option<&str>,
    ) -> impl std::future::Future<Output = AdapterResult<Option<String>>> + Send;

    /// Finalize a streamed message block. Override for format-switching
    /// (e.g., Feishu Card Kit: detect table/code → delete Post + send Card).
    /// Default: edit in place.
    fn finalize_message(
        &self,
        chat_id: &str,
        message_id: &str,
        text: &str,
    ) -> impl std::future::Future<Output = AdapterResult<()>> + Send;

    /// Whether this adapter uses draft streaming (affects finalize behavior).
    /// When true, finalize_block will delete draft + send_message instead of edit_message.
    fn use_draft_streaming(&self) -> bool { false }

    /// Preferred throttle interval in ms for draft edits. Default 1000ms.
    fn preferred_throttle_ms(&self) -> u64 { 1000 }
}
