import { account } from "./relay"

/** Email / password form for the traversalgame.com account (HTML over the canvases, so it can take text input) */
export class LoginForm {
  private root = document.getElementById("login")!
  private form = document.createElement("form")
  private email = document.createElement("input")
  private password = document.createElement("input")
  private error = document.createElement("p")
  private submit = document.createElement("button")
  private pending: ((ok: boolean) => void) | null = null

  constructor() {
    const title = document.createElement("h2")
    title.textContent = "Compte traversalgame.com"
    const note = document.createElement("p")
    note.className = "login-note"
    note.textContent = "Tes identifiants passent par le relais du projet jusqu'au site officiel ; rien n'est gardé en route."
    this.email.type = "email"
    this.email.autocomplete = "username"
    this.email.placeholder = "Adresse e-mail"
    this.password.type = "password"
    this.password.autocomplete = "current-password"
    this.password.placeholder = "Mot de passe"
    this.email.required = this.password.required = true
    this.error.className = "login-error"
    this.submit.type = "submit"
    this.submit.textContent = "Se connecter"
    const cancel = document.createElement("button")
    cancel.type = "button"
    cancel.textContent = "Annuler"
    cancel.addEventListener("click", () => this.close(false))
    const buttons = document.createElement("div")
    buttons.className = "login-buttons"
    buttons.append(cancel, this.submit)
    this.form.append(title, this.email, this.password, this.error, buttons, note)
    this.root.append(this.form)
    this.root.hidden = true

    this.form.addEventListener("submit", (e) => {
      e.preventDefault()
      void this.send()
    })
    // Typing here must not reach the game's shortcuts (Escape still closes the form)
    this.form.addEventListener("keydown", (e) => {
      e.stopPropagation()
      if (e.key === "Escape") this.close(false)
    })
  }

  /** Shows the form; resolves true once logged in, false if cancelled */
  ask() {
    this.pending?.(false)
    this.error.textContent = ""
    this.password.value = ""
    this.root.hidden = false
    ;(this.email.value ? this.password : this.email).focus()
    return new Promise<boolean>((resolve) => (this.pending = resolve))
  }

  private async send() {
    this.submit.disabled = true
    this.error.textContent = ""
    try {
      await account.login(this.email.value.trim(), this.password.value)
      this.close(true)
    } catch (e) {
      this.error.textContent = (e as Error).message
    } finally {
      this.submit.disabled = false
    }
  }

  private close(ok: boolean) {
    this.root.hidden = true
    this.password.value = ""
    this.pending?.(ok)
    this.pending = null
  }
}
