import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { LennoxS30Platform } from '../platform';
import { LennoxSystem } from 'lennoxapi';

/**
 * VentilationSwitchAccessory - Exposes ventilation control as a HomeKit Switch
 */
export class VentilationSwitchAccessory {
  private service: Service;

  constructor(
    private readonly platform: LennoxS30Platform,
    private readonly accessory: PlatformAccessory,
    private readonly system: LennoxSystem,
  ) {
    // Set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Lennox')
      .setCharacteristic(this.platform.Characteristic.Model, this.system.productType ?? 'S30/S40')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.system.serialNumber ?? 'Unknown');

    // Get or create switch service
    this.service = this.accessory.getService(this.platform.Service.Switch) ||
      this.accessory.addService(this.platform.Service.Switch);

    // Set display name
    this.service.setCharacteristic(this.platform.Characteristic.Name, 'Ventilation');

    // On/Off characteristic
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onGet(this.getOn.bind(this))
      .onSet(this.setOn.bind(this));

    // Register callback for push updates
    this.system.registerOnUpdateCallback(() => {
      this.updateCharacteristics();
    }, ['ventilationMode']);
  }

  /**
   * Update characteristics from system state (called via callback)
   */
  private updateCharacteristics(): void {
    this.service.updateCharacteristic(
      this.platform.Characteristic.On,
      this.getOn(),
    );
  }

  /**
   * Get current ventilation state
   */
  getOn(): CharacteristicValue {
    // Ventilation is on if mode is 'on' or if there's remaining time
    return this.system.ventilationMode === 'on' ||
           (this.system.ventilationRemainingTime !== null && this.system.ventilationRemainingTime > 0);
  }

  /**
   * Set ventilation state
   */
  async setOn(value: CharacteristicValue): Promise<void> {
    const on = value as boolean;

    try {
      if (on) {
        await this.system.ventilationOn();
      } else {
        await this.system.ventilationOff();
      }
      this.platform.log.debug(`Set ventilation to ${on ? 'ON' : 'OFF'}`);
    } catch (error) {
      this.platform.log.error('Failed to set ventilation:', (error as Error).message);
      throw error;
    }
  }
}

