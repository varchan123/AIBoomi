"""
Extract TEP fault signatures from raw Tennessee Eastman CSV files.
Expected input:
- TEP_Faulty_Testing.csv with columns such as faultNumber, sample, xmeas_1...xmeas_41, xmv_1...xmv_11
- TEP_FaultFree_Testing.csv optional, used for global normal baseline
- tep_variable_map.csv from this package

Output:
- tep_fault_summary_from_raw.csv
- tep_fault_signatures_from_raw.jsonl

Usage:
python scripts/extract_tep_fault_signatures.py \
  --faulty TEP_Faulty_Testing.csv \
  --faultfree TEP_FaultFree_Testing.csv \
  --varmap tep_variable_map.csv \
  --outdir output
"""
import argparse, json
from pathlib import Path
import pandas as pd
import numpy as np

def find_col(df, names):
    lower={c.lower():c for c in df.columns}
    for n in names:
        if n.lower() in lower: return lower[n.lower()]
    return None

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument('--faulty', required=True)
    ap.add_argument('--faultfree', default=None)
    ap.add_argument('--varmap', required=True)
    ap.add_argument('--outdir', required=True)
    ap.add_argument('--fault-start-sample', type=int, default=160)
    ap.add_argument('--top-n', type=int, default=8)
    args=ap.parse_args()
    out=Path(args.outdir); out.mkdir(parents=True, exist_ok=True)
    faulty=pd.read_csv(args.faulty)
    varmap=pd.read_csv(args.varmap)
    fault_col=find_col(faulty, ['faultNumber','fault_number','fault'])
    sample_col=find_col(faulty, ['sample','simulationRun','time','sample_number'])
    if fault_col is None:
        raise ValueError('Could not find faultNumber column')
    if sample_col is None:
        # create within-fault sample index if raw file does not provide one
        faulty['_sample_generated']=faulty.groupby(fault_col).cumcount()+1
        sample_col='_sample_generated'
    sensor_cols=[c for c in varmap['csv_column_name'].tolist() if c in faulty.columns]
    if not sensor_cols:
        raise ValueError('No xmeas/xmv columns found from variable map')
    global_baseline=None
    if args.faultfree:
        ff=pd.read_csv(args.faultfree)
        cols=[c for c in sensor_cols if c in ff.columns]
        global_baseline=ff[cols].mean(numeric_only=True)
    rows=[]; docs=[]
    meta=varmap.set_index('csv_column_name').to_dict('index')
    for fault_id, g in faulty.groupby(fault_col):
        if int(fault_id)==0: continue
        before=g[g[sample_col] < args.fault_start_sample]
        after=g[g[sample_col] >= args.fault_start_sample]
        if before.empty or after.empty: continue
        base_mean = global_baseline if global_baseline is not None else before[sensor_cols].mean(numeric_only=True)
        after_mean=after[sensor_cols].mean(numeric_only=True)
        before_std=before[sensor_cols].std(numeric_only=True).replace(0, np.nan)
        delta=after_mean-base_mean
        pct=(delta/base_mean.replace(0,np.nan))*100
        z=(delta/before_std).abs().replace([np.inf,-np.inf], np.nan).fillna(0)
        ranked=z.sort_values(ascending=False).head(args.top_n).index.tolist()
        anomalies=[]
        for rank, col in enumerate(ranked, 1):
            direction='increased' if delta[col]>0 else 'decreased'
            m=meta.get(col,{})
            anomalies.append({
                'rank':rank,
                'csv_column_name':col,
                'tep_tag':m.get('tep_tag'),
                'sensor_description':m.get('description',col),
                'mapped_machine_id':m.get('mapped_machine_id'),
                'unit':m.get('unit'),
                'baseline_mean':float(base_mean[col]),
                'fault_mean':float(after_mean[col]),
                'absolute_change':float(delta[col]),
                'percent_change':None if pd.isna(pct[col]) else float(pct[col]),
                'z_score_change':float(z[col]),
                'direction':direction
            })
        symptoms='; '.join([f"{a['sensor_description']} {a['direction']} (z={a['z_score_change']:.2f})" for a in anomalies[:5]])
        doc_id=f"TEP_Fault_{int(fault_id):02d}"
        text=(f"Document ID: {doc_id}\n"
              f"Source: Tennessee Eastman Process faulty testing data. Fault begins at sample {args.fault_start_sample}.\n"
              f"Sensor anomaly fingerprint: {symptoms}.\n"
              f"Use this signature to match live plant symptoms with historical RCA and maintenance logs.")
        docs.append({'document_id':doc_id,'source_type':'tep_fault_signature_from_raw','tep_fault_number':int(fault_id),'fault_start_sample':args.fault_start_sample,'top_anomalies':anomalies,'embedding_text':text})
        flat={'document_id':doc_id,'tep_fault_number':int(fault_id),'embedding_text':text.replace('\n',' ')}
        for a in anomalies[:5]:
            flat[f"top_{a['rank']}_sensor"]=a['csv_column_name']
            flat[f"top_{a['rank']}_description"]=a['sensor_description']
            flat[f"top_{a['rank']}_z_score"]=a['z_score_change']
            flat[f"top_{a['rank']}_direction"]=a['direction']
        rows.append(flat)
    pd.DataFrame(rows).to_csv(out/'tep_fault_summary_from_raw.csv', index=False)
    with open(out/'tep_fault_signatures_from_raw.jsonl','w') as fp:
        for d in docs: fp.write(json.dumps(d)+"\n")
if __name__=='__main__': main()
