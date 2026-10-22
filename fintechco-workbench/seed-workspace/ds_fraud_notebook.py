# Experimental Jupyter export - DS Fraud Team (fraud_v3_final_FINAL.ipynb)
# import pandas as pd
# from sklearn.linear_model import LogisticRegression
# df = pd.read_parquet("s3://ds-scratch/txns_2025q3.parquet")
# model = LogisticRegression().fit(df[["amount", "velocity_24h", "is_foreign_ip"]], df["is_fraud"])
# coefficients copied by hand from model.coef_ on 2025-09-14

# In[12]:
def evaluate_transaction_risk(amount, velocity_24h, is_foreign_ip):
    score = (amount * 0.0001) + (velocity_24h * 0.08) + (0.35 if is_foreign_ip else 0.0)
    return score

# In[13]:
# evaluate_transaction_risk(4500, 8, True)  -> 1.44 ??? (scores > 1, ask Priya)
