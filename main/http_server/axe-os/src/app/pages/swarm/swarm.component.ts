import { HttpClient } from '@angular/common/http';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormBuilder, FormGroup, Validators, FormControl } from '@angular/forms';
import { catchError, forkJoin, from, map, mergeMap, of, take, timeout, toArray } from 'rxjs';
import { LocalStorageService } from '../../services/local-storage.service';
import { SystemService } from 'src/app/services/system.service';
import { NbToastrService } from '@nebular/theme';
import { LoadingService } from '../../services/loading.service';
import { ISwarmAsicProfile } from '../../models/ISwarmAsicProfile';
import { IPool } from '../../models/IStratum';

const SWARM_DATA = 'SWARM_DATA';
const SWARM_REFRESH_TIME = 'SWARM_REFRESH_TIME';
const SWARM_ASIC_PROFILES = 'SWARM_ASIC_PROFILES';

@Component({
  selector: 'app-swarm',
  templateUrl: './swarm.component.html',
  styleUrls: ['./swarm.component.scss']
})
export class SwarmComponent implements OnInit, OnDestroy {

  public swarm: any[] = [];

  public selectedAxeOs: any = null;
  public showEdit = false;

  public form: FormGroup;

  public scanning = false;

  public refreshIntervalRef!: number;
  public refreshIntervalTime = 30;
  public refreshTimeSet = 30;

  public totals: { hashRate: number, power: number, efficiency: number, bestDiff: number, deviceCount: number, onlineCount: number } = { hashRate: 0, power: 0, efficiency: 0, bestDiff: 0, deviceCount: 0, onlineCount: 0 };

  public isRefreshing = false;

  public refreshIntervalControl: FormControl;

  public ipAddress: string;

  // Swarm Profiles
  public selectedIpAddresses: Set<string> = new Set();
  public profileForm: FormGroup;
  public savedProfiles: ISwarmAsicProfile[] = [];
  public selectedProfileName: string | null = null;

  // Legende
  public colorLegend: { color: string; label: string; count: number }[] = [];

  // Sorting
  public sortColumn: string = 'IP';
  public sortDirection: 'asc' | 'desc' = 'asc';

  // Search & Filter
  public searchTerm: string = '';
  public activeFilter: 'all' | 'offline' | 'hot' | 'underperforming' = 'all';

  constructor(
    private fb: FormBuilder,
    private systemService: SystemService,
    private toastrService: NbToastrService,
    private loadingService: LoadingService,
    private localStorageService: LocalStorageService,
    private httpClient: HttpClient
  ) {
    this.form = this.fb.group({
      manualAddIp: [null, [
        Validators.required,
        Validators.pattern('(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)')
      ]]
    });

    this.profileForm = this.fb.group({
      name: ['', Validators.required],
      frequency: [null, [Validators.min(100), Validators.max(2000)]],
      coreVoltage: [null, [Validators.min(800), Validators.max(2000)]]
    });

    this.savedProfiles = this.localStorageService.getObject(SWARM_ASIC_PROFILES) || [];

    const storedRefreshTime = this.localStorageService.getNumber(SWARM_REFRESH_TIME) ?? 30;
    this.refreshIntervalTime = storedRefreshTime;
    this.refreshTimeSet = storedRefreshTime;
    this.refreshIntervalControl = new FormControl(storedRefreshTime);

    this.refreshIntervalControl.valueChanges.subscribe(value => {
      this.refreshIntervalTime = value;
      this.refreshTimeSet = value;
      this.localStorageService.setNumber(SWARM_REFRESH_TIME, value);
    });
  }

  ngOnInit(): void {
    this.systemService.getInfo()
      .pipe(this.loadingService.lockUIUntilComplete())
      .subscribe({
        next: (info) => {
          this.ipAddress = info.hostip;
          const swarmData = this.localStorageService.getObject(SWARM_DATA);

          if (swarmData == null) {
            this.scanNetwork();
          } else {
            this.swarm = swarmData;
            this.refreshList();
          }

          this.startRefreshInterval();
        },
        error: () => {
          this.startRefreshInterval(); // Start periodic refresh even if info request fails
        }
      });
  }

  ngOnDestroy(): void {
    window.clearInterval(this.refreshIntervalRef);
    this.form.reset();
  }

  private startRefreshInterval(): void {
    this.refreshIntervalRef = window.setInterval(() => {
      if (!this.scanning && !this.isRefreshing) {
        this.refreshIntervalTime--;
        if (this.refreshIntervalTime <= 0) {
          this.refreshList();
        }
      }
    }, 1000);
  }

  private ipToInt(ip: string): number {
    return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
  }

  private intToIp(int: number): string {
    return `${(int >>> 24) & 255}.${(int >>> 16) & 255}.${(int >>> 8) & 255}.${int & 255}`;
  }

  private calculateIpRange(ip: string, netmask: string): { start: number, end: number } {
    const ipInt = this.ipToInt(ip);
    const netmaskInt = this.ipToInt(netmask);
    const network = ipInt & netmaskInt;
    const broadcast = network | ~netmaskInt;
    return { start: network + 1, end: broadcast - 1 };
  }

  // check if  /asic returns the expected fields
  private isValidAsicPayload(asic: any): boolean {
    return !!asic
      && typeof asic === 'object'
      && Array.isArray(asic.frequencyOptions)
      && Array.isArray(asic.voltageOptions)
      && ('deviceModel' in asic || 'ASICModel' in asic);
  }

  scanNetwork() {
    this.scanning = true;

    const { start, end } = this.calculateIpRange(this.ipAddress, '255.255.255.0');
    const ips = Array.from({ length: end - start + 1 }, (_, i) => this.intToIp(start + i));

    from(ips).pipe(
      mergeMap(ipAddr =>
        // get /info and /asic in parallel
        forkJoin({
          info: this.httpClient.get<any>(`http://${ipAddr}/api/system/info`).pipe(timeout(5000)),
          asic: this.httpClient.get<any>(`http://${ipAddr}/api/system/asic`).pipe(
            timeout(5000),
            catchError(() => of(null)) // /asic can be missing (302 etc.)
          )
        }).pipe(
          map(({ info, asic }) => {
            if (info && 'hashRate' in info) {
              const supportsAsicApi = this.isValidAsicPayload(asic);
              const merged = {
                IP: ipAddr,
                ...info,
                ...(supportsAsicApi ? {
                  ASICModel: asic.ASICModel ?? info.ASICModel,
                  asicCount: asic.asicCount ?? info.asicCount,
                  deviceModel: asic.deviceModel ?? info.deviceModel,
                  swarmColor: asic.swarmColor ?? 'blue',
                } : {}),
                supportsAsicApi,
                offline: false,
              };
              merged["expectedHashRate"] = Math.floor(merged.frequency * ((merged.smallCoreCount * merged.asicCount) / 1000));
              merged["bestDiff"] = this.convertBestDiffToNumber(merged["bestDiff"]);
              merged["bestSessionDiff"] = this.convertBestDiffToNumber(merged["bestSessionDiff"]);

              if (!merged['swarmColor']) merged['swarmColor'] = 'blue';
              return merged;
            }
            return null;
          }),
          catchError(() => of(null))
        ),
        128
      ),
      toArray()
    ).pipe(take(1)).subscribe({
      next: (result) => {
        const validResults = result.filter((item): item is NonNullable<typeof item> => item !== null);
        const existingIps = new Set(this.swarm.map(item => item.IP));
        const newItems = validResults.filter(item => !existingIps.has(item.IP));
        this.swarm = [...this.swarm, ...newItems].sort(this.sortByIp.bind(this));
        this.localStorageService.setObject(SWARM_DATA, this.swarm);
        this.calculateTotals();
        this.rebuildColorLegend();
      },
      complete: () => {
        this.scanning = false;
      }
    });
  }

  public add() {
    const newIp = this.form.value.manualAddIp;

    if (this.swarm.some(item => item.IP === newIp)) {
      this.toastrService.warning('This IP address already exists in the swarm', 'Duplicate Entry');
      return;
    }

    forkJoin({
      info: this.systemService.getInfo(0, 0, `http://${newIp}`),
      asic: this.httpClient.get<any>(`http://${newIp}/api/system/asic`).pipe(
        timeout(5000),
        catchError(() => of(null))
      )
    }).subscribe(({ info, asic }) => {
      if (info?.ASICModel) {
        const supportsAsicApi = this.isValidAsicPayload(asic);
        const merged = {
          IP: newIp,
          ...info,
          ...(supportsAsicApi ? {
            ASICModel: asic.ASICModel ?? info.ASICModel,
            asicCount: asic.asicCount ?? info.asicCount,
            deviceModel: asic.deviceModel ?? info.deviceModel,
            swarmColor: asic.swarmColor ?? 'blue'
          } : {}),
          supportsAsicApi,
          offline: false,
        };
        merged["expectedHashRate"] = Math.floor(merged.frequency * ((merged.smallCoreCount * merged.asicCount) / 1000));
        if (!merged['swarmColor']) merged['swarmColor'] = 'blue';

        merged["bestDiff"] = this.convertBestDiffToNumber(merged["bestDiff"]);
        merged["bestSessionDiff"] = this.convertBestDiffToNumber(merged["bestSessionDiff"]);

        this.swarm.push(merged);
        this.swarm = this.swarm.sort(this.sortByIp.bind(this));
        this.localStorageService.setObject(SWARM_DATA, this.swarm);
        this.calculateTotals();
        this.rebuildColorLegend();
      }
    });
  }

  public edit(axe: any) {
    if (!axe?.supportsAsicApi) {
      this.toastrService.warning(
        'To edit settings from the Swarm page, please update this device’s firmware.',
        'Firmware Update Needed'
      );
      return;
    }
    this.selectedAxeOs = axe;
    this.showEdit = true;
  }

  public restart(axe: any) {
    this.systemService.restart(`http://${axe.IP}`).pipe(
      catchError(error => {
        this.toastrService.danger(`Failed to restart device at ${axe.IP}`, 'Error');
        return of(null);
      })
    ).subscribe(res => {
      if (res !== null) {
        this.toastrService.success(`Nerd*Axe at ${axe.IP} restarted`, 'Success');
      }
    });
  }

  public remove(axeOs: any) {
    this.swarm = this.swarm.filter(axe => axe.IP != axeOs.IP);
    this.localStorageService.setObject(SWARM_DATA, this.swarm);
    this.calculateTotals();
    this.rebuildColorLegend();
  }

  public refreshList() {
    if (this.scanning) {
      return;
    }

    this.refreshIntervalTime = this.refreshTimeSet;
    const ips = this.swarm.map(axeOs => axeOs.IP);
    this.isRefreshing = true;

    from(ips).pipe(
      mergeMap(ipAddr =>
        forkJoin({
          info: this.httpClient.get<any>(`http://${ipAddr}/api/system/info`).pipe(timeout(5000)),
          asic: this.httpClient.get<any>(`http://${ipAddr}/api/system/asic`).pipe(
            timeout(5000),
            catchError(() => of(null))
          )
        }).pipe(
          map(({ info, asic }) => {
            const existingDevice = this.swarm.find(axeOs => axeOs.IP === ipAddr);
            const supportsAsicApi = this.isValidAsicPayload(asic) || !!existingDevice?.supportsAsicApi;
            const merged = {
              IP: ipAddr,
              ...existingDevice,
              ...info,
              ...(this.isValidAsicPayload(asic) ? {
                ASICModel: asic.ASICModel ?? info?.ASICModel ?? existingDevice?.ASICModel,
                asicCount: asic.asicCount ?? info?.asicCount ?? existingDevice?.asicCount,
                deviceModel: asic.deviceModel ?? info?.deviceModel ?? existingDevice?.deviceModel,
                swarmColor: asic.swarmColor ?? info?.swarmColor ?? existingDevice?.swarmColor
              } : {}),
              supportsAsicApi,
              offline: false,
            };
            merged["expectedHashRate"] = Math.floor(merged.frequency * ((merged.smallCoreCount * merged.asicCount) / 1000));
            if (!merged['swarmColor']) merged['swarmColor'] = existingDevice?.swarmColor ?? 'blue';
            merged["bestDiff"] = this.convertBestDiffToNumber(merged["bestDiff"]);
            merged["bestSessionDiff"] = this.convertBestDiffToNumber(merged["bestSessionDiff"]);
            return merged;
          }),
          catchError(error => {
            const errorMessage = error?.message || error?.statusText || error?.toString() || 'Unknown error';
            this.toastrService.danger('Failed to get info from ' + ipAddr, errorMessage);
            const existingDevice = this.swarm.find(axeOs => axeOs.IP === ipAddr);
            return of({
              ...existingDevice,
              IP: ipAddr,
              hashRate: 0,
              sharesAccepted: 0,
              power: 0,
              voltage: 0,
              temp: 0,
              bestDiff: 0,
              version: 0,
              uptimeSeconds: 0,
              poolDifficulty: 0,
              swarmColor: existingDevice?.swarmColor ?? 'blue',
              supportsAsicApi: existingDevice?.supportsAsicApi ?? false,
              offline: true,
            });
          })
        ),
        128
      ),
      toArray()
    ).pipe(take(1)).subscribe({
      next: (result) => {
        this.swarm = result.sort(this.sortByIp.bind(this));
        this.localStorageService.setObject(SWARM_DATA, this.swarm);
        this.calculateTotals();
        this.rebuildColorLegend();
        this.isRefreshing = false;
      },
      complete: () => {
        this.isRefreshing = false;
      }
    });
  }

  private sortByIp(a: any, b: any): number {
    return this.ipToInt(a.IP) - this.ipToInt(b.IP);
  }


  private convertBestDiffToNumber(bestDiff: string | number): number {
    if (typeof bestDiff === 'number') {
      return bestDiff;
    }
    if (!bestDiff || typeof bestDiff !== 'string') return 0;
    const value = parseFloat(bestDiff);
    if (isNaN(value)) return 0;
    const unit = bestDiff.slice(-1).toUpperCase();
    switch (unit) {
      case 'T': return value * 1_000_000_000_000;
      case 'G': return value * 1_000_000_000;
      case 'M': return value * 1_000_000;
      case 'K': return value * 1_000;
      default: return value;
    }
  }

  private calculateTotals() {
    this.totals.hashRate = this.swarm.reduce((sum, axe) => sum + (axe.hashRate || 0), 0);
    this.totals.power = this.swarm.reduce((sum, axe) => sum + (axe.power || 0), 0);
    this.totals.efficiency = this.totals.hashRate > 0 ? this.totals.power / (this.totals.hashRate / 1000) : 0;

    const numericDiffs = this.swarm
      .map(axe => this.convertBestDiffToNumber(axe.bestDiff))
      .filter(v => !isNaN(v) && isFinite(v));

    this.totals.bestDiff = numericDiffs.length > 0 ? Math.max(...numericDiffs) : 0;
    this.totals.deviceCount = this.swarm.length;
    this.totals.onlineCount = this.swarm.filter(axe => !axe.offline).length;
  }

  public getEfficiency(axe: any): number {
    if (!axe.hashRate || axe.hashRate === 0) return 0;
    return axe.power / (axe.hashRate / 1000);
  }

  public getHashRateProgress(axe: any): number {
    if (!axe.expectedHashRate || axe.expectedHashRate === 0) return 0;
    // Die Markierung im HTML ist bei 90%, daher wird die erwartete Hashrate auf 90% skaliert
    const progress = (axe.hashRate / axe.expectedHashRate) * 90;
    return Math.min(progress, 100);
  }

  public getHashRateStatus(axe: any): string {
    if (!axe.expectedHashRate || axe.expectedHashRate === 0) return 'info';
    const ratio = axe.hashRate / axe.expectedHashRate;
    if (ratio < 0.8) return 'danger';
    if (ratio < 0.95) return 'warning';
    return 'success';
  }

  hasModel(model: string): string {
    return this.swarm.some(axe => axe.ASICModel === model) ? '1' : '0.5';
  }

  hasMultipleChips(): string {
    return this.swarm.some(axe => axe.asicCount > 1) ? '1' : '0.5';
  }

  // Swarm color for the template
  public getSwarmColor(axe: any): string {
    return axe?.swarmColor || 'blue';
  }

  // build legend
  private rebuildColorLegend(): void {
    const mapLegend = new Map<string, { count: number; names: Set<string> }>();
    for (const axe of this.swarm) {
      const color = (axe?.swarmColor || '#007DB4').toString().trim();
      const name  = (axe?.deviceModel || axe?.ASICModel || 'Device').toString().trim();
      const entry = mapLegend.get(color) ?? { count: 0, names: new Set<string>() };
      entry.count++;
      if (name) entry.names.add(name);
      mapLegend.set(color, entry);
    }

    this.colorLegend = [...mapLegend.entries()].map(([color, { count, names }]) => {
      const labels = [...names];
      let label: string;
      if (labels.length === 1) label = labels[0];
      else if (labels.length === 2) label = `${labels[0]} + ${labels[1]}`;
      else label = `${labels[0]} + ${labels[1]} + ${labels.length - 2} more`;
      return { color, label, count };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
  }

  // --- ASIC Profile Methods ---
  public toggleDeviceSelection(ip: string, checked: boolean) {
    if (checked) {
      this.selectedIpAddresses.add(ip);
    } else {
      this.selectedIpAddresses.delete(ip);
    }
  }

  public isAllSelected(): boolean {
    return this.swarm.length > 0 && this.selectedIpAddresses.size === this.swarm.length;
  }

  public toggleSelectAll(checked: boolean) {
    if (checked) {
      this.swarm.forEach(axe => this.selectedIpAddresses.add(axe.IP));
    } else {
      this.selectedIpAddresses.clear();
    }
  }

  public onProfileSelect(profileName: string) {
    const profile = this.savedProfiles.find(p => p.name === profileName);
    if (!profile) return;
    this.selectedProfileName = profile.name;
    this.selectedIpAddresses.clear();
    if (profile.ips && profile.ips.length) {
      profile.ips.forEach(ip => {
        // Only select if the device actually exists in current swarm
        if (this.swarm.some(a => a.IP === ip)) {
          this.selectedIpAddresses.add(ip);
        }
      });
    }
    this.profileForm.patchValue({
      name: profile.name,
      frequency: profile.frequency,
      coreVoltage: profile.coreVoltage
    });
  }

  public saveProfile() {
    if (this.profileForm.invalid) {
      this.toastrService.warning('Please enter a valid profile name and settings.', 'Invalid Profile');
      return;
    }
    const val = this.profileForm.value;
    const newProfile: ISwarmAsicProfile = {
      name: val.name,
      frequency: val.frequency,
      coreVoltage: val.coreVoltage,
      ips: Array.from(this.selectedIpAddresses)
    };

    const existingIdx = this.savedProfiles.findIndex(p => p.name === newProfile.name);
    if (existingIdx >= 0) {
      this.savedProfiles[existingIdx] = newProfile;
    } else {
      this.savedProfiles.push(newProfile);
    }

    this.localStorageService.setObject(SWARM_ASIC_PROFILES, this.savedProfiles);
    this.selectedProfileName = newProfile.name;
    this.toastrService.success(`Profile ${newProfile.name} saved`, 'Success');
  }

  public backupProfile() {
    const name = this.profileForm.value.name;
    if (!name) {
      this.toastrService.warning('Please enter a profile name for the backup.', 'Name required');
      return;
    }

    const targetIps = this.selectedIpAddresses.size > 0 
      ? Array.from(this.selectedIpAddresses)
      : this.swarm.map(a => a.IP);

    const deviceSettings: { [ip: string]: { frequency: number, coreVoltage: number } } = {};
    
    for (const ip of targetIps) {
      // Find the device and check if it has the required values
      const device = this.swarm.find(a => a.IP === ip);
      if (device && device.frequency != null && device.coreVoltage != null) {
        deviceSettings[ip] = {
          frequency: device.frequency,
          coreVoltage: device.coreVoltage
        };
      }
    }

    const newProfile: ISwarmAsicProfile = {
      name: name,
      ips: targetIps,
      frequency: null,
      coreVoltage: null,
      deviceSettings: deviceSettings
    };

    const existingIdx = this.savedProfiles.findIndex(p => p.name === newProfile.name);
    if (existingIdx >= 0) {
      this.savedProfiles[existingIdx] = newProfile;
    } else {
      this.savedProfiles.push(newProfile);
    }

    this.localStorageService.setObject(SWARM_ASIC_PROFILES, this.savedProfiles);
    this.selectedProfileName = newProfile.name;
    this.toastrService.success(`Backup Profile ${newProfile.name} saved`, 'Success');
  }

  public deleteProfile() {
    const name = this.profileForm.value.name;
    if (!name) return;
    this.savedProfiles = this.savedProfiles.filter(p => p.name !== name);
    this.localStorageService.setObject(SWARM_ASIC_PROFILES, this.savedProfiles);
    this.toastrService.success(`Profile ${name} deleted`, 'Success');
    if (this.selectedProfileName === name) {
      this.selectedProfileName = null;
    }
    this.profileForm.reset();
    this.selectedIpAddresses.clear();
  }

  public applySettings() {
    if (this.selectedIpAddresses.size === 0) {
      this.toastrService.warning('No devices selected', 'Warning');
      return;
    }

    const val = this.profileForm.value;
    const loadedProfile = this.savedProfiles.find(p => p.name === this.selectedProfileName);

    const hasGlobalSettings = val.frequency != null || val.coreVoltage != null;
    const hasDeviceSettings = loadedProfile?.deviceSettings && Object.keys(loadedProfile.deviceSettings).length > 0;

    if (!hasGlobalSettings && !hasDeviceSettings) {
      this.toastrService.warning('Please enter frequency or voltage to apply, or load a backup profile', 'Warning');
      return;
    }

    const requests = Array.from(this.selectedIpAddresses).map(ip => {
      // Find if this specific device supportsAsicApi
      const device = this.swarm.find(a => a.IP === ip);
      if (!device?.supportsAsicApi) {
         this.toastrService.warning(`Skipped ${ip} - Firmware update required for ASIC API`, 'Skipped');
         return of(null);
      }
      
      const payload: any = {};
      
      // Merge logic: Per-device backup > Profile global form
      if (loadedProfile?.deviceSettings?.[ip]) {
        payload.frequency = loadedProfile.deviceSettings[ip].frequency;
        payload.coreVoltage = loadedProfile.deviceSettings[ip].coreVoltage;
      } else {
        if (val.frequency != null) payload.frequency = val.frequency;
        if (val.coreVoltage != null) payload.coreVoltage = val.coreVoltage;
      }

      // If nothing actually resolved for this specific IP, skip it gracefully
      if (payload.frequency == null && payload.coreVoltage == null) {
        return of(null);
      }

      return this.systemService.updateSystem(`http://${ip}`, payload).pipe(
        catchError(err => {
          this.toastrService.danger(`Failed to update settings for ${ip}`, 'Error');
          return of(null);
        })
      );
    });

    forkJoin(requests)
      .pipe(this.loadingService.lockUIUntilComplete())
      .subscribe(results => {
        const successCount = results.filter(r => r !== null).length;
        if (successCount > 0) {
          this.toastrService.success(`Applied settings to ${successCount} devices`, 'Success');
          // Wait a bit and refresh list
          setTimeout(() => this.refreshList(), 2000);
        }
      });
  }

  public isDualPoolEntry(axe: any): boolean {
    return !!axe?.stratum
      && axe.stratum.poolMode === 1
      && Array.isArray(axe.stratum.pools)
      && axe.stratum.pools.length >= 2;
  }

  public hasDualPoolRows(): boolean {
    for (const axe of this.swarm) {
      if (axe.stratum !== undefined) {
        return true;
      }
    }
    return false;
  }

  public getActivePoolHashrate(axe, i: 0 | 1) {
    const balance = this.getActiveBalance(axe, i);
    return axe.hashRate * balance * 10000000;
  }

  public getActiveBalance(axe, i: 0 | 1) {
    const stratum = axe.stratum;
    const active = stratum.pools.map((p: IPool) => p.connected && !p.verifyBlocked);
    const balance = stratum.poolBalance;

    // If neither pool is active
    if (!active[0] && !active[1]) return 0;

    // If both pools are active
    if (active[0] && active[1]) return i === 0 ? balance : 100 - balance;

    // Only one pool is active → return 100 for that pool, 0 for the other
    return active[i] ? 100 : 0;
  }

  public isPoolConnected(axe, i: 0 | 1) {
    return axe.stratum.pools[i].connected;
  }

  public getFrequencyValue(freq: any): number {
    return freq || 0;
  }

  public getVoltageValue(voltage: any): number {
    const val = voltage || 0;
    return val > 100 ? val / 1000.0 : val;
  }

  public getRejectRate(axe: any): number {
    const accepted = axe.sharesAccepted || 0;
    const rejected = axe.sharesRejected || 0;
    if (accepted === 0 && rejected === 0) return 0;
    return (rejected / (accepted + rejected)) * 100;
  }

  public getPoolRejectRate(pool: any): number {
    const accepted = pool?.accepted || 0;
    const rejected = pool?.rejected || 0;
    if (accepted === 0 && rejected === 0) return 0;
    return (rejected / (accepted + rejected)) * 100;
  }

  // --- Sorting ---
  public onSort(column: string): void {
    if (this.sortColumn === column) {
      this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      this.sortColumn = column;
      this.sortDirection = 'asc';
    }
  }

  private getSortValue(axe: any, column: string): number {
    switch (column) {
      case 'IP': return this.ipToInt(axe.IP);
      case 'hashRate': return axe.hashRate || 0;
      case 'uptimeSeconds': return axe.uptimeSeconds || 0;
      case 'temp': return axe.temp || 0;
      case 'power': return axe.power || 0;
      case 'efficiency': return this.getEfficiency(axe);
      case 'frequency': return axe.frequency || 0;
      default: return 0;
    }
  }

  public get displayedSwarm(): any[] {
    let list = [...this.swarm];

    if (this.searchTerm.trim()) {
      const term = this.searchTerm.toLowerCase().trim();
      list = list.filter(axe =>
        (axe.IP || '').toLowerCase().includes(term) ||
        (axe.hostname || '').toLowerCase().includes(term) ||
        (axe.deviceModel || '').toLowerCase().includes(term) ||
        (axe.ASICModel || '').toLowerCase().includes(term)
      );
    }

    switch (this.activeFilter) {
      case 'offline':
        list = list.filter(axe => axe.offline === true);
        break;
      case 'hot':
        list = list.filter(axe => axe.temp > ((axe.overheat_temp || 85) - 5));
        break;
      case 'underperforming':
        list = list.filter(axe => axe.expectedHashRate > 0 && (axe.hashRate / axe.expectedHashRate) < 0.8);
        break;
    }

    list.sort((a, b) => {
      const valA = this.getSortValue(a, this.sortColumn);
      const valB = this.getSortValue(b, this.sortColumn);
      const cmp = valA < valB ? -1 : valA > valB ? 1 : 0;
      return this.sortDirection === 'asc' ? cmp : -cmp;
    });

    return list;
  }

  public setFilter(filter: 'all' | 'offline' | 'hot' | 'underperforming'): void {
    this.activeFilter = this.activeFilter === filter ? 'all' : filter;
  }

  public getFilterCount(filter: string): number {
    switch (filter) {
      case 'offline': return this.swarm.filter(a => a.offline === true).length;
      case 'hot': return this.swarm.filter(a => a.temp > ((a.overheat_temp || 85) - 5)).length;
      case 'underperforming': return this.swarm.filter(a => a.expectedHashRate > 0 && (a.hashRate / a.expectedHashRate) < 0.8).length;
      default: return this.swarm.length;
    }
  }

  public isBackupProfile(profile: ISwarmAsicProfile): boolean {
    return !!profile.deviceSettings && Object.keys(profile.deviceSettings).length > 0;
  }

  public trackByIp(index: number, axe: any): string {
    return axe.IP;
  }
}
