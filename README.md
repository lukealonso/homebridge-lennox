# Homebridge Lennox

Homebridge plugin for Lennox S30, S40, E30, and M30 thermostats via local LAN connection. No cloud required.

## Features

- **Local Control**: Communicates directly with your thermostat over your local network
- **No Cloud Dependency**: Works without Lennox cloud services or account
- **Auto-Discovery**: Automatically detects zones and capabilities
- **Single Setpoint Mode**: Full support for Lennox's "Perfect Temp" auto mode
- **Multi-Thermostat**: Control multiple thermostats from a single plugin instance
- **HomeKit Native**: Proper thermostat controls with heating/cooling modes

### Exposed Accessories

- **Thermostat**: Temperature control, HVAC modes (Off, Heat, Cool, Auto), current temperature and humidity
- **Away Switch** (optional): Control manual away mode for automation
- **Ventilation Switch** (optional): Control ventilation system
- **Allergen Defender Switch** (optional): Control allergen defender mode
- **Outdoor Temperature** (optional): Expose outdoor temperature as a separate sensor

## Installation

### Via Homebridge UI

Search for "homebridge-lennox" in the Homebridge plugin search.

### Via Command Line

```bash
npm install -g homebridge-lennox
```

## Configuration

### Via Homebridge UI

1. Go to the Plugins tab
2. Find Homebridge Lennox and click Settings
3. Add your thermostat IP address(es)
4. Enable optional accessories as desired

### Manual Configuration

```json
{
  "platforms": [
    {
      "platform": "Lennox",
      "thermostats": [
        { "ipAddress": "192.168.1.100" },
        { "ipAddress": "192.168.1.101" }
      ],
      "pollInterval": 30,
      "accessories": {
        "awaySwitch": true,
        "ventilationSwitch": false,
        "allergenSwitch": false,
        "outdoorTemperature": false
      }
    }
  ]
}
```

### Configuration Options

| Option | Description | Default |
|--------|-------------|---------|
| `thermostats` | Array of thermostat configurations | Required |
| `thermostats[].ipAddress` | IP address or hostname of the thermostat | Required |
| `pollInterval` | How often to poll for updates (seconds) | 30 |
| `accessories.awaySwitch` | Expose away mode switch | false |
| `accessories.ventilationSwitch` | Expose ventilation switch (if supported) | false |
| `accessories.allergenSwitch` | Expose allergen defender switch (if supported) | false |
| `accessories.outdoorTemperature` | Expose outdoor temperature sensor (if available) | false |

## Finding Your Thermostat IP

Your Lennox thermostat's IP address can be found:

1. On the thermostat: Menu → Network → Wi-Fi Status
2. In your router's DHCP client list
3. Using a network scanner app

Consider assigning a static IP or DHCP reservation for reliability.

## Child Bridge (Recommended)

For stability, run this plugin as a child bridge:

1. In Homebridge UI, go to the plugin settings
2. Click the wrench icon → Bridge Settings
3. Enable "Run as a separate child bridge"

## Troubleshooting

### Thermostat not responding

- Verify the IP address is correct
- Ensure your Homebridge server can reach the thermostat (try `curl -k https://YOUR_IP/`)
- Check that no other integration (like Home Assistant) is connected

### Zones not appearing

- The plugin auto-detects active zones
- In single-zone (central) mode, only one thermostat appears
- Zone data may take up to 60 seconds to populate on first connection

### Accessory out of compliance

- Clear the Homebridge accessory cache and re-pair the bridge
- Remove the bridge from HomeKit and re-add it

## Credits

This plugin uses the [lennoxapi](https://www.npmjs.com/package/lennoxapi) library, which is a TypeScript port of [lennoxs30api](https://github.com/PeteRager/lennoxs30api) by Pete Rager.

## License

MIT

