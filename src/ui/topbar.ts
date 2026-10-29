import { audio, VolumeKind } from '../audio/audio';
import { GamepadInput } from '../input/gamepad';
import { Rumble } from '../input/rumble';
import { isTyping } from './chat';
import { $ } from './dom';
import { blurUnlessPad, usingPad } from './padnav';

/** A top-bar button's icon and word (the word is hidden on narrow screens). */
export function setLabel(b: HTMLElement, icon: string, text: string): void {
  const ico = document.createElement('span');
  ico.className = 'ico';
  ico.textContent = icon;
  const txt = document.createElement('span');
  txt.className = 'txt';
  txt.textContent = ` ${text}`;
  b.replaceChildren(ico, txt);
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
/** A short message at the top of the screen. */
export function showToast(text: string): void {
  const el = $('#toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 1500);
}

/** The audio buttons (sound, music), the volume sliders under them, and the controller's rumble switch. */
export class TopBar {
  readonly volumeButton = $<HTMLButtonElement>('#toggle-volume');
  private readonly muteButton = $<HTMLButtonElement>('#toggle-mute');
  private readonly musicButton = $<HTMLButtonElement>('#toggle-music');
  private readonly rumbleButton = $<HTMLButtonElement>('#toggle-rumble');
  private readonly volumePanel = $('#volume-panel');
  private readonly volumeInputs = [...this.volumePanel.querySelectorAll<HTMLInputElement>('input[data-volume]')];

  constructor(private readonly pad: GamepadInput, private readonly rumble: Rumble) {
    this.muteButton.addEventListener('click', () => { audio.toggleMute(); blurUnlessPad(this.muteButton); });
    this.musicButton.addEventListener('click', () => { audio.toggleMusic(); blurUnlessPad(this.musicButton); });
    window.addEventListener('keydown', e => {
      if (e.code === 'KeyM' && !e.repeat && !isTyping(e)) audio.toggleMute();
    });

    for (const input of this.volumeInputs) {
      input.addEventListener('input', () => audio.setVolume(input.dataset.volume as VolumeKind, Number(input.value) / 100));
      input.addEventListener('change', () => blurUnlessPad(input)); // give the arrow keys back to the game
    }
    this.volumeButton.addEventListener('click', () => {
      this.volumePanel.classList.toggle('hidden');
      this.renderVolumes();
      if (usingPad() && this.volumeOpen) this.volumeInputs[0].focus(); // straight to the sliders
      else blurUnlessPad(this.volumeButton);
    });
    document.addEventListener('pointerdown', e => {
      if (!(e.target as Element).closest('.audio-toggles')) this.closeVolume();
    });

    this.rumbleButton.addEventListener('click', () => { rumble.toggle(); this.renderPad(); blurUnlessPad(this.rumbleButton); });

    audio.onChange(() => { this.renderAudio(); this.renderVolumes(); });
    this.renderAudio();
  }

  get volumeOpen(): boolean {
    return !this.volumePanel.classList.contains('hidden');
  }

  closeVolume(): void {
    this.volumePanel.classList.add('hidden');
  }

  /** The rumble switch and the controller hint show while a controller is connected. */
  renderPad(): void {
    const connected = this.pad.connected;
    this.rumbleButton.classList.toggle('hidden', !connected);
    setLabel(this.rumbleButton, '🎮', 'Rumble');
    this.rumbleButton.classList.toggle('off', !this.rumble.on);
    $('#pad-hint').classList.toggle('hidden', !connected);
  }

  private renderAudio(): void {
    setLabel(this.muteButton, audio.muted ? '🔇' : '🔊', 'Sound');
    this.muteButton.classList.toggle('off', audio.muted);
    setLabel(this.musicButton, '♪', 'Music');
    this.musicButton.classList.toggle('off', !audio.musicOn);
  }

  private renderVolumes(): void {
    for (const input of this.volumeInputs) {
      const pct = Math.round(audio.volume[input.dataset.volume as VolumeKind] * 100);
      if (document.activeElement !== input) input.value = String(pct);
      (input.nextElementSibling as HTMLOutputElement).value = `${pct}%`;
    }
  }
}
