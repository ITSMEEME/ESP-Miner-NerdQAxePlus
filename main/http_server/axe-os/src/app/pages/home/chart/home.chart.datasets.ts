import { HOME_CFG } from '../home.cfg';

// Auto-extracted from the original HomeComponent constructor.
// Visual/design layer only.

export interface HomeChartSeriesRefs {
  labels: number[];
  hr1m: number[];
  hr10m: number[];
  hr1h: number[];
  hr1d: number[];
  vregTemp: number[];
  asicTemp: number[];
  fanSpeed: number[];
}

export function createHomeDatasets(opts: { t: (key: string) => string; series: HomeChartSeriesRefs }): any[] {
  const { t, series } = opts;
  const HR_BASE_COLOR = HOME_CFG.colors.hashrateBase;

  function hrColor(alpha: number = 1): string {
    if (alpha >= 1) return HR_BASE_COLOR;
    const hex = HR_BASE_COLOR.replace('#', '');
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function hr1mAreaGradient(context: any): CanvasGradient | string {
    const chart = context?.chart;
    const ctx = chart?.ctx;
    const chartArea = chart?.chartArea;
    if (!ctx || !chartArea) return hrColor(0.3);
    const gradient = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
    gradient.addColorStop(0, hrColor(0.3));
    gradient.addColorStop(1, hrColor(0));
    return gradient;
  }

  return [

  {
    type: 'line',
    label: t('HOME.HASHRATE_1M'),
    tooltipOrderKey: 'hr_1m',
    data: series.hr1m,
    yAxisID: 'y',
    fill: 'start',
    backgroundColor: (context: any) => hr1mAreaGradient(context),
    borderColor: hrColor(1),
    pill: { bg: hrColor(1) },
    tension: 0.6,
    cubicInterpolationMode: 'monotone',
    pointRadius: 0,
    borderWidth: 2.1
  },
  {
    type: 'line',
    label: t('HOME.HASHRATE_10M'),
    tooltipOrderKey: 'hr_10m',
    data: series.hr10m,
    yAxisID: 'y',
    fill: false,
    backgroundColor: hrColor(0),
    borderColor: hrColor(0.9),
    tension: .4,
    cubicInterpolationMode: 'monotone',
    pointRadius: 0,
    borderWidth: 1.8,
    borderDash: [1, 4],
    borderCapStyle: 'round'
  },
  {
    type: 'line',
    label: t('HOME.HASHRATE_1H'),
    tooltipOrderKey: 'hr_1h',
    data: series.hr1h,
    yAxisID: 'y',
    fill: false,
    backgroundColor: hrColor(0),
    borderColor: hrColor(0.8),
    tension: .4,
    cubicInterpolationMode: 'monotone',
    pointRadius: 0,
    borderWidth: 1.8,
    borderDash: [8, 2]
  },
  {
    type: 'line',
    label: t('HOME.HASHRATE_1D'),
    tooltipOrderKey: 'hr_1d',
    data: series.hr1d,
    hidden: true,
    excludeFromLegend: true,
    yAxisID: 'y',
    fill: false,
    backgroundColor: hrColor(0),
    borderColor: hrColor(0.8),
    tension: .4,
    cubicInterpolationMode: 'monotone',
    pointRadius: 0,
    borderWidth: 1.8,
    borderDash: [14, 8]
  }
  ];
}

export function createHeatDatasets(opts: { t: (key: string) => string; series: HomeChartSeriesRefs }): any[] {
  const { t, series } = opts;

  return [
    {
      type: 'line',
      label: t('PERFORMANCE.VR_TEMP'),
      data: series.vregTemp,
      yAxisID: 'y_temp',
      borderColor: '#ff8a65',
      backgroundColor: '#ff8a65',
      tension: .4,
      pointRadius: 0,
      borderWidth: 1
    },
    {
      type: 'line',
      label: t('PERFORMANCE.ASIC_TEMP'),
      data: series.asicTemp,
      yAxisID: 'y_temp',
      borderColor: '#f06292',
      backgroundColor: '#f06292',
      tension: .4,
      pointRadius: 0,
      borderWidth: 1
    },
    {
      type: 'line',
      label: t('HOME.FAN_SPEED'),
      data: series.fanSpeed,
      yAxisID: 'y_percent',
      borderColor: '#00bcd4',
      backgroundColor: '#00bcd4',
      tension: .4,
      pointRadius: 0,
      borderWidth: 1
    }
  ];
}

export function applyHomeDatasetRenderOrder(datasets: any[]): void {
  const hr1m: any = datasets?.[0];
  const hr10m: any = datasets?.[1];
  const hr1h: any = datasets?.[2];
  const hr1d: any = datasets?.[3];

  if (hr1m) hr1m.order = 0;
  if (hr10m) hr10m.order = 10;
  if (hr1h) hr1h.order = 11;
  if (hr1d) hr1d.order = 12;
}
