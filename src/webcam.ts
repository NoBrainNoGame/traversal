import type { RtcSignal } from "../shared/protocol"
import type { Seat } from "../shared/rules"
import type { Net } from "./net"

const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }]

/**
 * Webcam link between the two players, peer to peer (WebRTC), signalled through the host.
 * Uses the "perfect negotiation" pattern: either side may (re)start it, Blue gives way on a collision.
 * Emits "change" when the camera or microphone is turned on or off.
 */
export class Webcam extends EventTarget {
  private pc: RTCPeerConnection | null = null
  private stream: MediaStream | null = null
  private polite = false
  private makingOffer = false
  private ignoreOffer = false
  private remote = document.createElement("video")
  private local = document.createElement("video")

  constructor(private net: Net) {
    super()
    for (const video of [this.remote, this.local]) {
      video.autoplay = video.playsInline = true
      video.hidden = true
    }
    this.local.muted = true
    this.local.className = "webcam-local"
    document.getElementById("webcams")!.append(this.remote, this.local)
  }

  get on() {
    return !!this.stream
  }

  get micOn() {
    return !!this.stream?.getAudioTracks().some((t) => t.enabled)
  }

  /** Our seat is (re)assigned: tell the other player so the link starts over with the right roles */
  joined(seat: Seat | null) {
    this.polite = seat === 1
    if (seat === null) return
    this.reset()
    this.signal({ kind: "hello" })
  }

  async start() {
    if (this.stream) return
    if (!navigator.mediaDevices?.getUserMedia) throw new Error("Le navigateur ne donne la webcam qu'aux pages sécurisées : ouvre l'adresse https du jeu.")
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 }, audio: { echoCancellation: true } })
    } catch {
      throw new Error("Webcam refusée ou introuvable.")
    }
    this.local.srcObject = this.stream
    this.local.hidden = false
    this.reset()
    this.signal({ kind: "hello" })
    this.dispatchEvent(new Event("change"))
  }

  stop() {
    if (!this.stream) return
    for (const track of this.stream.getTracks()) track.stop()
    this.stream = null
    this.local.hidden = true
    this.signal({ kind: "bye" })
    this.reset()
    this.dispatchEvent(new Event("change"))
  }

  toggleMic() {
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !track.enabled
    this.dispatchEvent(new Event("change"))
  }

  async onSignal(signal: RtcSignal) {
    if (signal.kind === "hello" || signal.kind === "bye") return this.reset()
    try {
      if (signal.kind === "description") {
        const pc = this.pc ?? this.connect()
        const description = signal.description as RTCSessionDescriptionInit
        const collision = description.type === "offer" && (this.makingOffer || pc.signalingState !== "stable")
        this.ignoreOffer = !this.polite && collision
        if (this.ignoreOffer) return
        await pc.setRemoteDescription(description)
        if (description.type === "offer") {
          await pc.setLocalDescription()
          this.signal({ kind: "description", description: pc.localDescription!.toJSON() })
        }
      } else if (signal.kind === "candidate" && this.pc) {
        await this.pc.addIceCandidate(signal.candidate as RTCIceCandidateInit)
      }
    } catch (e) {
      if (!this.ignoreOffer) console.warn("[webcam]", e)
    }
  }

  /** Drops the current link; with our camera on, offers a fresh one right away */
  private reset() {
    this.pc?.close()
    this.pc = null
    this.remote.srcObject = null
    this.remote.hidden = true
    if (this.stream) this.connect()
  }

  private connect() {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
    this.pc = pc
    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true
        await pc.setLocalDescription()
        this.signal({ kind: "description", description: pc.localDescription!.toJSON() })
      } catch (e) {
        console.warn("[webcam]", e)
      } finally {
        this.makingOffer = false
      }
    }
    pc.onicecandidate = ({ candidate }) => candidate && this.signal({ kind: "candidate", candidate: candidate.toJSON() })
    pc.ontrack = (e) => {
      this.remote.srcObject = e.streams[0] ?? new MediaStream([e.track])
      this.remote.hidden = false
    }
    for (const track of this.stream?.getTracks() ?? []) pc.addTrack(track, this.stream!)
    return pc
  }

  private signal(signal: RtcSignal) {
    this.net.send({ t: "rtc", signal })
  }
}
