import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';

import { LennoxS30Platform } from '../platform';
import { LennoxSystem } from 'lennoxapi';

/**
 * AwaySwitchAccessory - Exposes the Lennox manual away mode as a HomeKit Switch
 */
export class AwaySwitchAccessory {
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
    this.service.setCharacteristic(this.platform.Characteristic.Name, 'Away Mode');

    // On/Off characteristic - set initial value
    const onValue = this.getOn();
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .onGet(this.getOn.bind(this))
      .onSet(this.setOn.bind(this));
    this.service.updateCharacteristic(this.platform.Characteristic.On, onValue);
    this.platform.log.info(`Away Switch ${this.system.name}: On=${onValue}`);

    // Register callback for push updates
    this.system.registerOnUpdateCallback(() => {
      this.updateCharacteristics();
    }, ['manualAwayMode']);
  }

  /**
   * Update characteristics from system state (called via callback)
   */
  private updateCharacteristics(): void {
    const onValue = this.getOn();
    this.platform.log.debug(`Away Switch ${this.system.name}: publishing On=${onValue}`);
    this.service.getCharacteristic(this.platform.Characteristic.On)
      .sendEventNotification(onValue);
  }

  /**
   * Get current away mode state
   */
  getOn(): CharacteristicValue {
    return this.system.getManualAwayMode();
  }

  /**
   * Set away mode state
   */
  async setOn(value: CharacteristicValue): Promise<void> {
    const on = value as boolean;

    try {
      await this.system.setManualAwayMode(on);
      this.platform.log.debug(`Set away mode to ${on ? 'ON' : 'OFF'}`);
    } catch (error) {
      this.platform.log.error('Failed to set away mode:', (error as Error).message);
      throw error;
    }
  }
}
