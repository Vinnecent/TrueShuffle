package expo.modules.spotifynowplaying

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val METADATA_CHANGED = "com.spotify.music.metadatachanged"
private const val PLAYBACK_STATE_CHANGED = "com.spotify.music.playbackstatechanged"
private const val CHANGE_EVENT = "onChange"

/**
 * Listens for the broadcasts the Spotify app sends when "Device Broadcast Status" is on in its settings
 * (https://developer.spotify.com/documentation/android/tutorials/android-media-notifications).
 * No Spotify login or Web API call is involved; Android delivers them only while the receiver is registered,
 * i.e. while JS is listening for "onChange".
 */
class SpotifyNowPlayingModule : Module() {
  private var receiver: BroadcastReceiver? = null

  // Latest values from both broadcasts, merged into one state for JS.
  private var trackId: String? = null
  private var title: String? = null
  private var artist: String? = null
  private var album: String? = null
  private var length: Long? = null
  private var playing: Boolean? = null
  private var positionMs: Long = 0
  private var positionAt: Long = 0

  override fun definition() = ModuleDefinition {
    Name("SpotifyNowPlaying")

    Events(CHANGE_EVENT)

    /** The last known state, or null if Spotify has not broadcast anything since listening started. */
    Function("getState") { currentState() }

    OnStartObserving(CHANGE_EVENT) { startListening() }

    OnStopObserving(CHANGE_EVENT) { stopListening() }

    OnDestroy { stopListening() }
  }

  private val context: Context?
    get() = appContext.reactContext

  private fun startListening() {
    val ctx = context ?: return
    if (receiver != null) return
    val newReceiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context, intent: Intent) {
        handle(intent)
      }
    }
    val filter = IntentFilter().apply {
      addAction(METADATA_CHANGED)
      addAction(PLAYBACK_STATE_CHANGED)
    }
    // Spotify is another app, so the receiver must be exported (required to be explicit from Android 13).
    val sticky = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      ctx.registerReceiver(newReceiver, filter, Context.RECEIVER_EXPORTED)
    } else {
      @Suppress("UnspecifiedRegisterReceiverFlag")
      ctx.registerReceiver(newReceiver, filter)
    }
    receiver = newReceiver
    // Spotify's broadcasts are sticky: the last one is handed over on registration, so the current
    // song is known straight away instead of only after the next change.
    sticky?.let { handle(it) }
  }

  private fun stopListening() {
    val r = receiver ?: return
    receiver = null
    try {
      context?.unregisterReceiver(r)
    } catch (_: IllegalArgumentException) {
      // Already unregistered.
    }
  }

  @Synchronized
  private fun handle(intent: Intent) {
    val sentAt = intent.getLongExtra("timeSent", System.currentTimeMillis())
    when (intent.action) {
      METADATA_CHANGED -> {
        val newId = intent.getStringExtra("id")
        val changedTrack = newId != trackId
        trackId = newId
        title = intent.getStringExtra("track")
        artist = intent.getStringExtra("artist")
        album = intent.getStringExtra("album")
        length = numberExtra(intent, "length")
        if (intent.hasExtra("playing")) playing = intent.getBooleanExtra("playing", false)
        // A new song starts at 0; a later playback broadcast refines this.
        if (changedTrack && sentAt >= positionAt) {
          positionMs = numberExtra(intent, "playbackPosition") ?: 0
          positionAt = sentAt
        }
      }
      PLAYBACK_STATE_CHANGED -> {
        // An older sticky broadcast must not override a newer state.
        if (sentAt < positionAt) return
        playing = intent.getBooleanExtra("playing", false)
        positionMs = numberExtra(intent, "playbackPosition") ?: positionMs
        positionAt = sentAt
      }
      else -> return
    }
    currentStateLocked()?.let { sendEvent(CHANGE_EVENT, it) }
  }

  /** Int or Long extra, whichever Spotify used. */
  private fun numberExtra(intent: Intent, key: String): Long? {
    @Suppress("DEPRECATION")
    return (intent.extras?.get(key) as? Number)?.toLong()
  }

  @Synchronized
  private fun currentState(): Map<String, Any?>? = currentStateLocked()

  private fun currentStateLocked(): Map<String, Any?>? {
    if (trackId == null && playing == null) return null
    return mapOf(
      "trackId" to trackId,
      "title" to title,
      "artist" to artist,
      "album" to album,
      "length" to length?.toDouble(),
      "playing" to (playing ?: false),
      "positionMs" to positionMs.toDouble(),
      "positionAt" to positionAt.toDouble(),
    )
  }
}
